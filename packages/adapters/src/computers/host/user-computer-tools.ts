// Tool names and the app label the approval card shows. Kept free of Node imports: the web
// approval-card fixture loads approval-ask.ts in the browser.
export const USER_COMPUTER_SHELL_TOOL = "user_computer_shell";
export const USER_COMPUTER_OBSERVE_TOOL = "user_computer_observe";
export const USER_COMPUTER_ACT_TOOL = "user_computer_act";
/** Sets the folder on the user's computer this bot works in for them. */
export const USER_COMPUTER_FOLDER_TOOL = "user_computer_folder";
/** Hands a task to the coding agent on the user's computer, in the bot's project folder. */
export const USER_COMPUTER_AGENT_TOOL = "user_computer_agent";
/** Sends a file from the user's computer to the chat. */
export const USER_COMPUTER_ATTACH_TOOL = "user_computer_attach";
/** Keeps a command running on the user's computer, such as a dev server, and stops it. */
export const USER_COMPUTER_PROCESS_TOOL = "user_computer_process";
/** Calls the HTTP API of an app running on the user's computer. */
export const USER_COMPUTER_REQUEST_TOOL = "user_computer_request";
/** Both look at or drive one app, so one approval covers that app for the chat. */
export const USER_COMPUTER_SCREEN_TOOLS: ReadonlySet<string> = new Set([
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_ACT_TOOL,
]);
export const USER_COMPUTER_TOOLS: ReadonlySet<string> = new Set([
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_FOLDER_TOOL,
  USER_COMPUTER_AGENT_TOOL,
  USER_COMPUTER_ATTACH_TOOL,
  USER_COMPUTER_PROCESS_TOOL,
  USER_COMPUTER_REQUEST_TOOL,
  ...USER_COMPUTER_SCREEN_TOOLS,
]);

/** The app a screen call names, as its approval card shows it and later calls match it. */
export function userComputerAppName(value: unknown): string {
  return String(value ?? "")
    .replaceAll(/[^\p{L}\p{N} .&'+-]/gu, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
