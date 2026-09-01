import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.INVOKER_DB_DIR = join(homedir(), '.invoker', 'test');
