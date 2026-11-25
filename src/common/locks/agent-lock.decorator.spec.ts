import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AGENT_LOCK_KEY, UseAgentLock } from './agent-lock.decorator';

describe('UseAgentLock', () => {
  it('sets the agent-lock metadata with default options', () => {
    class Controller {
      @UseAgentLock()
      update(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(AGENT_LOCK_KEY, Controller.prototype.update)).toEqual({});
  });

  it('stores custom key resolver and ttl options', () => {
    const keyResolver = () => 'agent:custom';

    class Controller {
      @UseAgentLock({ key: keyResolver, ttl: 1000 })
      update(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(AGENT_LOCK_KEY, Controller.prototype.update)).toEqual({
      key: keyResolver,
      ttl: 1000,
    });
  });

  it('is only applied to the decorated method', () => {
    class Controller {
      @UseAgentLock()
      update(): void {}

      list(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(AGENT_LOCK_KEY, Controller.prototype.update)).toEqual({});
    expect(reflector.get(AGENT_LOCK_KEY, Controller.prototype.list)).toBeUndefined();
  });
});
