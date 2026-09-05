'use client'

/**
 * NotificationSettings — self-contained settings card for desktop + sound
 * notification preferences.
 *
 * Renders three iOS-style toggle switches (desktop notifications / sound /
 * only-when-hidden), the current Notification.permission badge, a "请求
 * 通知权限" button when permission isn't granted, and a "测试通知"
 * button that fires a test notification + chime so the user can verify
 * their setup.
 *
 * All settings persist to localStorage via the helpers in
 * `use-task-notification` (key: 'dagents:notification-settings') and the
 * sound flag additionally mirrors to 'dagents:sound-enabled' for the
 * sound utility to read.
 *
 * Designed to drop into the existing 通知 tab in settings-view.tsx, but
 * is fully self-contained (own CSS import, own state, own handlers) so it
 * can also be placed anywhere else (onboarding, profile menu, …).
 */

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import {
  readNotificationSettings,
  writeNotificationSettings,
  type NotificationSettings as NotificationSettingsState,
} from '@/lib/use-task-notification'

/** SSR-safe defaults — the REAL stored values load in an effect below.
 *  Reading localStorage during render caused hydration mismatches whenever
 *  the user had changed any switch (server renders defaults, client's first
 *  render renders the stored values). */
const SSR_DEFAULT_SETTINGS: NotificationSettingsState = {
  desktopEnabled: true,
  soundEnabled: true,
  onlyWhenHidden: false,
}
import {
  playSuccessSound,
  playSoftBeep,
  setSoundEnabled,
} from '@/lib/notification-sound'
import '@/styles/notification-settings.css'

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

function getPermission(): PermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as PermissionState
}

const PERMISSION_LABEL: Record<PermissionState, string> = {
  default: '未授权',
  granted: '已授权',
  denied: '已拒绝',
  unsupported: '不支持',
}

export function NotificationSettings(): React.ReactElement {
  const { t } = useI18n()
  const [settings, setSettings] = useState<NotificationSettingsState>(SSR_DEFAULT_SETTINGS)
  const [permission, setPermission] = useState<PermissionState>('unsupported')
  const [testHint, setTestHint] = useState<string | null>(null)

  // Hydrate from storage / browser AFTER mount (see SSR_DEFAULT_SETTINGS).
  useEffect(() => {
    setSettings(readNotificationSettings())
    setPermission(getPermission())
  }, [])

  // Re-sync permission state when the tab regains focus (the browser's
  // permission prompt may have been answered in another tab / window).
  useEffect(() => {
    const onFocus = (): void => setPermission(getPermission())
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const update = useCallback(
    (patch: Partial<NotificationSettingsState>): void => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        writeNotificationSettings(next)
        // Keep the sound utility's flag in sync so the change takes effect
        // immediately (the util reads localStorage on each play).
        if (patch.soundEnabled !== undefined) {
          setSoundEnabled(patch.soundEnabled)
        }
        return next
      })
    },
    [],
  )

  const handleRequestPermission = useCallback(async (): Promise<void> => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    try {
      const result = await Notification.requestPermission()
      setPermission(result as PermissionState)
    } catch {
      // Some browsers throw if called outside a user gesture — the click
      // handler guarantees one, but be defensive.
      setTestHint(t('权限请求失败 — 请在浏览器站点设置中手动允许通知'))
    }
  }, [t])

  const handleTest = useCallback((): void => {
    // Fire a desktop notification (if enabled + granted) so the user can
    // see what completion notifications look like.
    if (
      settings.desktopEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        const n = new Notification(t('🔔 Dagents 测试通知'), {
          body: t('如果你看到这条消息，说明桌面通知已正确配置。'),
          icon: '/favicon.ico',
          tag: 'dagents-test',
        })
        n.onclick = (): void => {
          window.focus()
          n.close()
        }
      } catch {
        // ignore — fall through to sound
      }
    }
    // Desktop requested but NOT granted — say so; a silent "nothing happened"
    // is indistinguishable from a broken config.
    if (
      settings.desktopEnabled &&
      (typeof Notification === 'undefined' || Notification.permission !== 'granted')
    ) {
      setTestHint(t('桌面通知未授权 — 本次仅播放声音'))
    } else {
      setTestHint(null)
    }
    // Play a chime so the user can also verify the sound.
    if (settings.soundEnabled) {
      // Use the success chime for a positive test signal.
      playSuccessSound()
      // Follow with a soft beep 200ms later for a recognisable two-stage cue.
      setTimeout(() => playSoftBeep(), 200)
    }
  }, [settings.desktopEnabled, settings.soundEnabled, t])

  const permissionVariant =
    permission === 'granted'
      ? 'granted'
      : permission === 'denied'
        ? 'denied'
        : 'default'

  return (
    <div className="notif-settings-card">
      <div className="notif-settings-head">
        <div className="notif-settings-title">{t('桌面通知与提示音')}</div>
        <div className="notif-settings-desc">
          {t('当长时间运行的 Agent 任务完成或失败时，即使你切换了浏览器标签页也会收到通知。')}
        </div>
      </div>

      <div className="notif-settings-permission">
        <span className="notif-settings-permission-label">{t('通知权限状态')}</span>
        <span
          className={`notif-perm-badge notif-perm-${permissionVariant}`}
          role="status"
        >
          {t(PERMISSION_LABEL[permission])}
        </span>
        {permission === 'default' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm notif-perm-request"
            onClick={() => void handleRequestPermission()}
          >
            {t('请求通知权限')}
          </button>
        ) : null}
        {permission === 'denied' ? (
          <span className="notif-perm-hint">
            {t('浏览器已拒绝。请在站点设置中重新允许通知。')}
          </span>
        ) : null}
        {permission === 'unsupported' ? (
          <span className="notif-perm-hint">{t('当前浏览器不支持桌面通知。')}</span>
        ) : null}
      </div>

      <div className="notif-settings-toggles">
        <NotifToggle
          title={t('桌面通知')}
          desc={t('任务完成或失败时弹出系统级桌面通知')}
          checked={settings.desktopEnabled}
          onChange={(v) => update({ desktopEnabled: v })}
        />
        <NotifToggle
          title={t('通知声音')}
          desc={t('任务完成或失败时播放一声轻柔提示音（音量已限制在较低水平）')}
          checked={settings.soundEnabled}
          onChange={(v) => update({ soundEnabled: v })}
        />
        <NotifToggle
          title={t('仅标签页失焦时通知')}
          desc={t('开启后仅在你切走当前标签页时通知；关闭则在切换到其他对话时也通知')}
          checked={settings.onlyWhenHidden}
          onChange={(v) => update({ onlyWhenHidden: v })}
        />
      </div>

      <div className="notif-settings-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm notif-test-btn"
          onClick={handleTest}
        >
          {t('测试通知')}
        </button>
        {testHint ? (
          <span className="notif-perm-hint" role="status" style={{ marginTop: 'var(--space-2)' }}>{testHint}</span>
        ) : null}
      </div>
    </div>
  )
}

interface NotifToggleProps {
  title: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}

function NotifToggle({
  title,
  desc,
  checked,
  onChange,
}: NotifToggleProps): React.ReactElement {
  const handleToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      onChange(e.target.checked)
    },
    [onChange],
  )
  return (
    <div className="toggle-row notif-toggle-row">
      <div className="info">
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
      </div>
      <label className="switch notif-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={handleToggle}
          aria-label={title}
        />
        <span className="track" />
      </label>
    </div>
  )
}
