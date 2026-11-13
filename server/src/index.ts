import { migrate } from './db';
import { seedIfEmpty } from './seed';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 8080);

async function main() {
  await migrate();
  await seedIfEmpty();
  createApp().listen(port, () => {
    console.log(`[server] 生鲜订货决策系统后端已启动: http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error('[server] 启动失败:', e);
  process.exit(1);
});
