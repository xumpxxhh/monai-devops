import { spawn } from 'child_process';
import path from 'path';

const child = spawn('pnpm build', {
  shell: true,
  cwd: path.join(process.cwd()),
  env: process.env,
});

child.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

child.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

child.on('close', (code) => {
  console.log(`退出码: ${code}`);
});
