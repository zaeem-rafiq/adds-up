// Reads {"left": [...], "right": [...]} from standard input and prints the adding rule's
// state of every cell, so a script in another language can use the product's own rule.
import { proveColumns } from "../src/lib/adding.ts";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const { left, right } = JSON.parse(text);
const proof = proveColumns(left, right);
console.log(JSON.stringify({ left: proof.left.cellStatuses, right: proof.right.cellStatuses }));
