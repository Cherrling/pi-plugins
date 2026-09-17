/**
 * protocol.ts — message types and prompt templates for the
 * boss/worker orchestration protocol.
 */

export type MessageType = "chat" | "task" | "result";

export interface Message {
	fromId: string;
	fromName: string;
	/** chat | task | result */
	type: MessageType;
	/** links a result back to the task that caused it */
	taskId?: string;
	text: string;
	ts: number;
}

export function newTaskId(): string {
	return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Render an incoming message as the user-message prompt injected into
 * the receiving conversation. The wording drives the receiving agent's
 * behavior, so keep the per-type contracts explicit.
 */
export function renderIncoming(msg: Message): string {
	if (msg.type === "task") {
		return (
			`📋 [任务派发，来自 session "${msg.fromName}"] taskId=${msg.taskId}\n` +
			`${msg.text}\n\n` +
			`(这是跨会话任务。完成该任务后，必须调用 send_session_message 回报：` +
			`收件人 "${msg.fromName}"，内容包含 taskId=${msg.taskId}、任务结果或产物路径。` +
			`如果任务无法完成，也要回报原因。开始干活吧。)`
		);
	}
	if (msg.type === "result") {
		return (
			`✅ [任务回报，来自 session "${msg.fromName}"] taskId=${msg.taskId}\n` +
			`${msg.text}\n\n` +
			`(这是跨会话任务回报。记录该结果并继续你的编排工作；如需追问，` +
			`用 send_session_message 回复 "${msg.fromName}"。)`
		);
	}
	return (
		`📨 [来自另一个 pi session: ${msg.fromName}] ${msg.text}\n\n` +
		`(这是跨会话消息。如需回复，调用 send_session_message 工具，收件人 "${msg.fromName}"。` +
		`如果不需要回复就忽略或简单处理。)`
	);
}
