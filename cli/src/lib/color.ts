/**
 * stderr is colored only when it is a TTY and NO_COLOR is unset — the
 * --no-color/--plain flags set NO_COLOR before any command runs.
 */
export function colorize(color: string, text: string, stream: NodeJS.WriteStream = process.stderr): string {
  if (!stream.isTTY || process.env.NO_COLOR) return text;
  return `${color}${text}\x1b[0m`;
}

export function red(text: string, stream?: NodeJS.WriteStream): string {
  return colorize("\x1b[31m", text, stream);
}
