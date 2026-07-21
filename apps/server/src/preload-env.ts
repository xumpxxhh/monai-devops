import { config } from 'dotenv';

// .env.local 优先；已存在的 process.env 不覆盖（与原先手写逻辑一致）
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
