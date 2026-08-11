/**
 * notification-sound — Web Audio API tones for task notifications.
 *
 * Generates short pleasant beeps on the fly — no audio files needed. The
 * AudioContext is lazily created on first play (browsers require a user
 * gesture before audio can start, so we never construct one at import time).
 *
 * All sounds respect the `dagents:sound-enabled` localStorage flag (default
 * true) and cap gain at 0.15 so the chime is subtle, never jarring.
 *
 *   playSuccessSound() — two-tone ascending chime (880Hz → 1320Hz, 150ms)
 *   playErrorSound()   — descending tone (440Hz → 220Hz, 200ms)
 *   playSoftBeep()     — single 800Hz blip, 80ms
 *
 * Each function is a no-op when the flag is off, when AudioContext is
 * unavailable (older browsers / SSR), or when the user has not yet
 * interacted with the page (the first play resolves silently).
 */

const SOUND_ENABLED_KEY = 'dagents:sound-enabled'
/** Subtle volume ceiling — never let the chime surprise the user. */
const MAX_VOLUME = 0.15

/**
 * Lazily-resolved AudioContext. We keep a single module-level instance so
 * repeated plays reuse the same context (browsers cap the count). Resumes
 * the context if the browser auto-suspended it after inactivity.
 */
let ctx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  // A tab that's been backgrounded may auto-suspend its context; resume on use.
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      // resume can reject if the user hasn't gestured yet — silent no-op
    })
  }
  return ctx
}

/**
 * Read the sound-enabled flag from localStorage. Default true (opt-out).
 * Access errors (private mode / SSR) fall back to enabled so a sandboxed
 * storage never accidentally mutes the chime.
 */
export function isSoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(SOUND_ENABLED_KEY)
    return v === null ? true : v === 'true'
  } catch {
    return true
  }
}

/** Toggle the sound-enabled flag from elsewhere (e.g. settings panel). */
export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, String(enabled))
  } catch {
    // sandboxed storage — best-effort
  }
}

/**
 * Play a tone with a frequency ramp between `fromHz` and `toHz` over
 * `durationMs`. The gain envelope (quick attack, gentle release) avoids
 * the clicks raw oscillators make on start/stop.
 */
function playTone(
  fromHz: number,
  toHz: number,
  durationMs: number,
  when: number,
  gainNode: GainNode,
): void {
  const ac = getAudioContext()
  if (!ac) return
  const osc = ac.createOscillator()
  const start = when
  const end = start + durationMs / 1000
  osc.type = 'sine'
  osc.frequency.setValueAtTime(fromHz, start)
  if (toHz !== fromHz) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(toHz, 1), end)
  }
  osc.connect(gainNode)
  osc.start(start)
  osc.stop(end + 0.02)
}

/** Set up a gain envelope for a sound starting at `when`. */
function envelope(
  when: number,
  totalMs: number,
  gain: number,
): GainNode | null {
  const ac = getAudioContext()
  if (!ac) return null
  const g = ac.createGain()
  const total = totalMs / 1000
  // Attack (10ms ramp in) → hold → release (40ms ramp out).
  g.gain.setValueAtTime(0, when)
  g.gain.linearRampToValueAtTime(gain, when + 0.01)
  g.gain.setValueAtTime(gain, when + Math.max(total - 0.04, 0.01))
  g.gain.linearRampToValueAtTime(0, when + total)
  g.connect(ac.destination)
  return g
}

/**
 * Two-tone ascending chime: 880Hz (75ms) → 1320Hz (75ms), total 150ms.
 * Pleasant, distinct from system sounds, used for task success.
 */
export function playSuccessSound(): void {
  if (!isSoundEnabled()) return
  const ac = getAudioContext()
  if (!ac) return
  const t0 = ac.currentTime
  const g1 = envelope(t0, 80, MAX_VOLUME)
  if (g1) playTone(880, 880, 75, t0, g1)
  // Second tone slightly louder feel via overlap; same ceiling.
  const g2 = envelope(t0 + 0.07, 80, MAX_VOLUME * 0.9)
  if (g2) playTone(1320, 1320, 80, t0 + 0.07, g2)
}

/**
 * Descending tone: 440Hz → 220Hz over 200ms. Lower pitch than success so
 * the user can distinguish error vs completion without looking.
 */
export function playErrorSound(): void {
  if (!isSoundEnabled()) return
  const ac = getAudioContext()
  if (!ac) return
  const t0 = ac.currentTime
  const g = envelope(t0, 200, MAX_VOLUME)
  if (g) playTone(440, 220, 200, t0, g)
}

/**
 * Single soft 800Hz beep, 80ms. Used as a lighter attention signal (e.g.
 * info notifications that are neither success nor failure).
 */
export function playSoftBeep(): void {
  if (!isSoundEnabled()) return
  const ac = getAudioContext()
  if (!ac) return
  const t0 = ac.currentTime
  const g = envelope(t0, 80, MAX_VOLUME * 0.8)
  if (g) playTone(800, 800, 80, t0, g)
}

export const NOTIFICATION_SOUND_STORAGE_KEY = SOUND_ENABLED_KEY
