import ollama from "ollama";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { tools, executeTool } from "./tools/index.js";

async function main() {
    p.intro(chalk.cyan("Nou CLI Started! 🌞"));

    const messages: any[] = [
        {
            role: "system",
            content: "You are a helpful coding assistant. You can run commands and read files to help the user."
        }
    ];

    while (true) {
        const query = await p.text({
            message: "What can I help with?",
            placeholder: "",
        });

        if (p.isCancel(query)) break;

        messages.push({
            role: "user",
            content: query as string
        });

        const s = p.spinner();
        s.start("Pondering.......");

        const response = await ollama.chat({
            model: "lllama3.1",
            messages: messages,
            tools: tools
        });

        s.stop("Done!");

        if (response.message.tool_calls) {
            for (const call of response.message.tool_calls) {
                p.log.step(`Executing: ${chalk.yellow(call.function.name)}....`);

                const result = - await executeTool(call.function.name, call.function.arguments);

                messages.push(response.message);
                messages.push({
                    role: "tool",
                    content: result,
                    name: call.function.name
                });
            }

            const finalResponse = await ollama.chat({
                model: "llama3.1",
                messages: messages
            });

            console.log(`\n${chalk.green("AI: ")} ${finalResponse.message.content}\n`);
        } else {
            console.log(`\n${chalk.green("AI: ")} ${response.message.content}\n`);
        }
    }
    p.outro(chalk.cyan("Bye bye!"));
}

main().catch(console.error); 