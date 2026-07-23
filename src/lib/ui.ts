import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "../toolkit/index.js";

export const backRow = [inlineButton("Back to menu", "menu:main")];

export function withBack(rows: Parameters<typeof inlineKeyboard>[0]): InlineKeyboardMarkup {
  return inlineKeyboard([...rows, backRow]);
}

export function backKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([backRow]);
}

export function cancelKeyboard(data = "flow:cancel"): InlineKeyboardMarkup {
  return inlineKeyboard([[inlineButton("Cancel", data)], backRow]);
}
