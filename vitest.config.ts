import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@remotex\/shared\/(.*)$/, replacement: r('./shared/$1') },
      { find: /^@remotex\/auth\/(.*)$/, replacement: r('./authentication/$1') },
      { find: /^@remotex\/security\/(.*)$/, replacement: r('./security/$1') },
      { find: /^@remotex\/input\/(.*)$/, replacement: r('./remote-input/$1') },
      { find: /^@remotex\/media\/(.*)$/, replacement: r('./media-engine/$1') },
      { find: /^@remotex\/capture\/(.*)$/, replacement: r('./screen-capture/$1') },
      { find: /^@remotex\/audio\/(.*)$/, replacement: r('./audio/$1') },
      { find: /^@remotex\/recording\/(.*)$/, replacement: r('./recording/$1') },
      { find: /^@remotex\/admin\/(.*)$/, replacement: r('./admin/$1') },
      { find: /^@remotex\/devices\/(.*)$/, replacement: r('./device-management/$1') },
      { find: /^@remotex\/signaling\/(.*)$/, replacement: r('./signaling-server/$1') },
      { find: /^@remotex\/database\/(.*)$/, replacement: r('./database/$1') },
    ],
  },
  test: {
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
