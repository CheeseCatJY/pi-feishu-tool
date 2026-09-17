/**
 * 适配器工厂。pi.mode 决定系统怎样接触 PI，其它模块不感知这个分支。
 *
 * 三种形态的区别一句话说明：
 * - mock：不碰 PI，管线模拟，用来验证系统本身；
 * - cli ：`pi --print` 一次性跑完，简单可靠，但中途无法与人交互；
 * - rpc ：`pi --mode rpc` 常驻会话，能拿到 PI 的文字、工具调用，也能接住它的提问。
 */
import type { AppConfig } from '../config/config.ts';
import { CliAgentAdapter } from './cli-runner.ts';
import { MockAgentAdapter } from './mock-runner.ts';
import { RpcAgentAdapter } from './rpc-runner.ts';
import type { AgentAdapter } from './pi-runner.ts';
import type { ProcessManager } from './process-manager.ts';

export function createAgentAdapter(config: AppConfig, processManager: ProcessManager): AgentAdapter {
  switch (config.pi.mode) {
    case 'cli':
      return new CliAgentAdapter(config, processManager);
    case 'rpc':
      return new RpcAgentAdapter(config);
    case 'mock':
    default:
      return new MockAgentAdapter(config);
  }
}
