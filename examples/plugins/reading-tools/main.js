export async function onEvent(event) {
	if (event !== "paper:opened") return;
	const count = (await agentero.call("storage.get", { key: "visits" })) ?? 0;
	await agentero.call("storage.set", { key: "visits", value: count + 1 });
}

export async function run(command, context) {
	const chinese = context.locale.startsWith("zh");
	if (command === "visits") {
		const count = (await agentero.call("storage.get", { key: "visits" })) ?? 0;
		return chinese ? `已打开论文 ${count} 次` : `Papers opened: ${count}`;
	}
	if (!context.paperRef)
		throw new Error(chinese ? "请先选择论文" : "Select a paper first");
	if (command === "mark-read") {
		const paper = await agentero.call("paper.set_read", {
			ref: context.paperRef,
			isRead: true,
		});
		return paper.title;
	}
	if (command === "save-selection") {
		if (!context.selectionText)
			throw new Error(chinese ? "请先选中文字" : "Select text first");
		const notes = await agentero.call("paper.notes.get", {
			ref: context.paperRef,
		});
		await agentero.call("paper.notes.write", {
			ref: context.paperRef,
			expectedRevision: notes.revision,
			mode: "append",
			content: `\n\n## ${context.settings.heading}\n\n${context.selectionText}\n`,
		});
		return chinese ? "已保存到笔记" : "Saved to notes";
	}
}
