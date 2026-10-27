// On-screen keyboard for the optional free-text question (pure key handling).

export const QUESTION_MAX = 300;

export const KEY_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '?', 'back'],
  ['space', '.', 'clear'],
];

export interface KeyboardState {
  text: string;
  shift: boolean;
}

export function applyKey(s: KeyboardState, key: string, max = QUESTION_MAX): KeyboardState {
  switch (key) {
    case 'shift':
      return { ...s, shift: !s.shift };
    case 'back':
      return { ...s, text: [...s.text].slice(0, -1).join('') };
    case 'clear':
      return { text: '', shift: false };
    case 'space':
      if (!s.text || s.text.endsWith(' ') || s.text.length >= max) return s;
      return { ...s, text: s.text + ' ' };
    default: {
      if ([...key].length !== 1 || s.text.length >= max) return s;
      // Capitalise when shift is on, or at the start of the question.
      const ch = s.shift || s.text.length === 0 ? key.toUpperCase() : key;
      return { text: s.text + ch, shift: false };
    }
  }
}

/** The question as it is sent: trimmed, single spaces, at most `max` characters. */
export function finalQuestion(text: string, max = QUESTION_MAX): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}
