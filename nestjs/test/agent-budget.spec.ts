import { AgentBudget } from '../src/modules/agent/agent-budget';
describe('AgentBudget', () => {
  it('persists reservations before requests and conservatively charges missing usage on resume', async () => {
    const checkpoints: any[] = []; const state = AgentBudget.initial();
    const budget = new AgentBudget(state, async () => { checkpoints.push(structuredClone(state)); });
    const id = await budget.before({kind:'tools', model:'test', input:'abc', maxOutputTokens:100});
    expect(checkpoints[0].calls).toBe(1); expect(checkpoints[0].reservations[id]).toBeGreaterThanOrEqual(103);
    await budget.settle(id, {status:'success'}); expect(state.tokens).toBeGreaterThanOrEqual(103);
    expect(new AgentBudget(state, async () => {}).state.calls).toBe(1);
  });
  it('reserves one final request and rejects excess calls', async () => {
    const state = AgentBudget.initial(); state.calls = 31;
    const budget = new AgentBudget(state, async () => {});
    await expect(budget.before({kind:'tools',model:'x',input:'a',maxOutputTokens:1})).rejects.toThrow();
  });
  it('serializes reservations across observers sharing a snapshot', async () => {
    const state=AgentBudget.initial();let active=0,peak=0;
    const checkpoint=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;};
    const a=new AgentBudget(state,checkpoint),b=new AgentBudget(state,checkpoint);
    await Promise.all([a.before({kind:'tools',model:'x',input:'a',maxOutputTokens:1}),b.before({kind:'tools',model:'x',input:'b',maxOutputTokens:1})]);
    expect(peak).toBe(1);expect(state.calls).toBe(2);
  });
});
