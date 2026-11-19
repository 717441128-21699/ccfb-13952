/** Node 测试环境下补齐浏览器 performance API */
import { performance } from 'node:perf_hooks';

if (!globalThis.performance) {
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => performance.now() },
    configurable: true,
  });
}
