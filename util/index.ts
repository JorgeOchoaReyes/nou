import { highlight } from "cli-highlight";
import fs from 'fs/promises';
import path from 'path';

export const sugarfy = (str: string) => {
    return highlight(str, { language: "typescript", ignoreIllegals: true });
};

export async function getProjectMap(dir: string, depth = 0): Promise<string> {
  if (depth > 2) return '';
  
  const files = await fs.readdir(dir, { withFileTypes: true });
  let map = '';

  for (const file of files) {
    if (file.name === 'node_modules' || file.name === '.git') continue;
    
    const indentation = '  '.repeat(depth);
    map += `${indentation}${file.isDirectory() ? '📁' : '📄'} ${file.name}\n`;
    
    if (file.isDirectory()) {
      map += await getProjectMap(path.join(dir, file.name), depth + 1);
    }
  }
  return map;
}