#!/usr/bin/env node

console.log(JSON.stringify({ type: "thread.started", thread_id: "test" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"ok\"}" } }));
