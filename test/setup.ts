import fs from 'fs';
import os from 'os';
import path from 'path';

// Test files run in parallel processes, so each gets its own throwaway data
// directory. The db module reads DATA_DIR at import time — import this module
// before importing anything from ../src.
export const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bereal-test-'));
process.env.DATA_DIR = testDataDir;
