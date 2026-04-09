import ollama from "ollama";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { tools, executeTool } from "./tools/index.js"; 
import { artWork, ensureProjectContext, loadPermanentContext } from "./util/index.js";

async function main() {
  p.intro(chalk.cyan(`${artWork} \n Hello I am Nou! 🌞`));
 
  await ensureProjectContext(); 
 
  const permContext = await loadPermanentContext();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: { role: string; content: any; name?: string }[] = [
    {
      role: "system",
      content: `You are a coding assistant. Current directory structure:\n${permContext}`   
    }
  ];

  while (true) {
    const query = await p.text({
      message: "What can I help you with? (Type 'exit' to quit)",
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
      model: "llama3.1",
      messages: messages,
      tools: tools
    });

    s.stop("Done thinking!");

    if (response.message.tool_calls) {
      for (const call of response.message.tool_calls) {
        p.log.step(`Executing: ${chalk.yellow(call.function.name)}....`);

        p.log.info(`With arguments: ${chalk.blue(JSON.stringify(call.function.arguments))}`);

        const confirm = await p.confirm({
          message: `Nou wants to run: ${chalk.yellow(call.function.arguments.command)}. Allow?`,
        });
      
        if (!confirm || p.isCancel(confirm)) {
          messages.push({
            role: "tool",
            content: "User denied permission to run this command.",
            name: call.function.name
          });
          continue; 
        }

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

      console.log(`\n${chalk.green("Nou: ")} ${finalResponse.message.content}\n`);
    } else {
      console.log(`\n${chalk.green("Nou: ")} ${response.message.content}\n`);
    }
  }
  p.outro(chalk.cyan("Bye bye!"));
}

main().catch(console.error); 