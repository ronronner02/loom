import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
lines.on('line', line => {
  const packet = JSON.parse(line);
  if (packet.method === 'initialize') send({ id: packet.id, result: { userAgent: 'protocol-test' } });
  if (packet.method === 'thread/start') {
    if (packet.params.sandbox !== 'workspace-write' || packet.params.approvalsReviewer !== 'user') process.exit(3);
    send({ id: packet.id, result: { thread: { id: 'test-thread' } } });
  }
  if (packet.method === 'turn/start') {
    send({ id: packet.id, result: { turn: { id: 'test-turn' } } });
    send({ id: 'permission-1', method: 'item/commandExecution/requestApproval', params: { command: 'echo verified', cwd: process.cwd() } });
  }
  if (packet.id === 'permission-1') {
    if (packet.result?.decision !== 'decline') process.exit(4);
    send({ id: 'question-1', method: 'item/tool/call', params: { tool: 'ask_owner', arguments: { question: 'What should the result say?' } } });
  }
  if (packet.id === 'question-1') {
    const text = packet.result.contentItems[0].text;
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
    send({ method: 'turn/completed', params: { turn: { id: 'test-turn', status: 'completed' } } });
  }
});
