export async function run(_command, context) {
	const paper = await agentero.call("paper.get", { ref: context.paperRef });
	return paper.title;
}
