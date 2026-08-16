/**
 * ws-hub — gateway WebSocket hub for chat realtime events.
 *
 * 设计参考 multica server/internal/realtime/hub.go：
 *   - 浏览器连到 /ws，可选在 URL query 带 ?chat=<id> 订阅特定 chat
 *   - hub 维护 WebSocket Set，每个 socket 声明自己订阅的 chatId 集合
 *   - broadcastChat(chatId, event) 只推给订阅了该 chatId 的 sockets
 *   - 未声明订阅的 socket 不收到任何 chat 事件（避免噪音）
 *
 * 事件协议（参考 multica protocol.EventChatMessage 等）：
 *   - chat:message  — 流式 token 片段（streaming=true）
 *   - chat:done     — 任务完成，携带完整内容
 *   - chat:error    — 执行失败
 *   - chat:session_updated — chat 状态变化（可选）
 *
 * 每个 frame 是 JSON 字符串：{ type, chatId, runId, role, content, ... }
 * 浏览器端用 useWsClient hook 订阅。
 */
import { WebSocketServer, WebSocket } from 'ws'
import { createLogger } from '@dagents/shared'
import type { TokenUsage } from '@dagents/contracts'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Server } from 'node:http'
import { authConfigured, verifyApiKey } from './auth.js'

const log = createLogger({ svc: 'gateway:ws-hub' })

/** 推送给浏览器的 chat 事件类型。 */
export type ChatEventType = 'chat:message' | 'chat:done' | 'chat:error' | 'chat:session_updated'

/** 推送给浏览器的 chat 事件 payload。 */
export interface ChatEvent {
  type: ChatEventType
  chatId: string
  runId?: string
  role: 'assistant' | 'user' | 'system'
  content: string
  /** true 表示这是流式片段（chat:message），false 表示完整消息（chat:done）。 */
  streaming?: boolean
  /** 任务状态（仅 chat:done 携带）。 */
  status?: string
  /** 错误信息（仅 chat:error 携带）。 */
  error?: string
  /** Token 用量（chat:done 由内部回调携带；Task 4.1 将正式纳入协议）。 */
  usage?: TokenUsage
  /** 运行耗时毫秒（chat:done 携带）。 */
  durationMs?: number
  /** 运行成本（chat:done 携带）。 */
  cost?: number
}

interface ClientConn {
  ws: WebSocket
  /** 该 socket 订阅的 chatId 集合。空集合 = 不收任何 chat 事件。 */
  subscribedChats: Set<string>
}

class WsHub {
  private clients = new Set<ClientConn>()
  private wss: WebSocketServer | null = null

  /** 把 WebSocketServer 挂到已有的 HTTP server 上，处理 /ws 升级请求。 */
  attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const reject = (): void => {
        // 必须显式拒绝：注册了 upgrade 监听后 Node 不再自动销毁未处理
        // 的连接，半开 socket 会一直挂着（连接耗尽向量）。
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      // 浏览器 WebSocket 握手不受同源策略约束（cross-site WebSocket
      // hijacking）：本机模式下任何网页都能连 ws://127.0.0.1:8080/ws 偷看
      // 聊天流。配置了 GATEWAY_API_KEY 时要求 token（query 或 header）+
      // 同源 Origin，二选一满足即可（非浏览器客户端无 Origin）。
      if (authConfigured()) {
        const token =
          url.searchParams.get('token') ??
          req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ??
          ''
        if (!verifyApiKey(token)) {
          reject()
          return
        }
        const origin = req.headers.origin
        if (origin) {
          let originHost: string | null = null
          try {
            originHost = new URL(origin).host
          } catch {
            originHost = null
          }
          const host = req.headers.host ?? ''
          if (!originHost || originHost !== host) {
            reject()
            return
          }
        }
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      // 初始订阅：从 ?chat=id1&id2 query 解析（支持多个）
      const initialChats = url.searchParams.getAll('chat')
      const conn: ClientConn = {
        ws,
        subscribedChats: new Set(initialChats),
      }
      this.clients.add(conn)
      log.info('ws client connected', {
        count: this.clients.size,
        initialChats: initialChats.length,
      })

      ws.on('message', (raw) => {
        // 客户端可发 subscribe/unsubscribe 帧动态切换订阅
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'subscribe' && typeof msg.chatId === 'string') {
            conn.subscribedChats.add(msg.chatId)
            log.info('ws subscribe', {
              chatId: msg.chatId,
              clientSubs: [...conn.subscribedChats],
              totalClients: this.clients.size,
            })
          } else if (msg.type === 'unsubscribe' && typeof msg.chatId === 'string') {
            conn.subscribedChats.delete(msg.chatId)
            log.info('ws unsubscribe', { chatId: msg.chatId })
          }
        } catch {
          // 忽略非 JSON 或格式错误的消息
        }
      })

      ws.on('close', () => {
        this.clients.delete(conn)
        log.info('ws client disconnected', { count: this.clients.size })
      })

      ws.on('error', (err) => {
        log.warn('ws client error', { error: err.message })
        this.clients.delete(conn)
      })
    })
  }

  /** 广播 chat 事件给所有订阅了该 chatId 的客户端。 */
  broadcastChat(chatId: string, event: ChatEvent): void {
    const frame = JSON.stringify(event)
    const subscribedClients = []
    for (const conn of this.clients) {
      if (conn.subscribedChats.has(chatId) && conn.ws.readyState === WebSocket.OPEN) {
        subscribedClients.push(conn)
      }
    }
    if (subscribedClients.length === 0) {
      log.warn('broadcastChat: no subscribed client', {
        chatId,
        eventType: event.type,
        totalClients: this.clients.size,
      })
    }
    for (const conn of subscribedClients) {
      try {
        conn.ws.send(frame)
      } catch (err) {
        log.warn('ws send failed', { error: String(err) })
      }
    }
  }

  /** 当前连接数（测试用）。 */
  get clientCount(): number {
    return this.clients.size
  }
}

/** 全局单例。inline-executor 和 routes 都用它广播事件。 */
export const wsHub = new WsHub()
