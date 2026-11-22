// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA v1 (see ISA.md).
// Plain JavaScript in a .ts file: Node 22 runs it as-is.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_STEPS = 1000000;
const MAX_OUT = 65536;

function run(prog, input) {
  const st = new Int32Array(256);   // data stack
  const mem = new Int32Array(256);  // memory words
  const cs = new Int32Array(64);    // call stack
  const out = new Uint8Array(MAX_OUT);
  const n = prog.length;
  let sp = 0, csp = 0, pc = 0, steps = 0, olen = 0, iptr = 0;
  const done = (code) => ({ out: out.slice(0, olen), code });

  for (;;) {
    if (steps === MAX_STEPS) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = prog[pc];
    const known = op <= 7 || (op >= 16 && op <= 34) || (op >= 48 && op <= 52) ||
      (op >= 64 && op <= 65) || (op >= 80 && op <= 83);
    if (!known) return done(5);
    let ilen = 1;
    if (op === 1) ilen = 2;
    else if (op === 2) ilen = 5;
    else if (op >= 48 && op <= 51) ilen = 3;
    if (pc + ilen > n) return done(9);
    steps++;
    const next = pc + ilen;

    switch (op) {
      case 0: return done(0); // HALT
      case 1: { // PUSH8, sign-extended
        if (sp === 256) return done(3);
        const b = prog[pc + 1];
        st[sp++] = b < 128 ? b : b - 256;
        pc = next;
        break;
      }
      case 2: { // PUSH32, little-endian signed
        if (sp === 256) return done(3);
        st[sp++] = prog[pc + 1] | (prog[pc + 2] << 8) | (prog[pc + 3] << 16) | (prog[pc + 4] << 24);
        pc = next;
        break;
      }
      case 3: // POP
        if (sp < 1) return done(2);
        sp--;
        pc = next;
        break;
      case 4: // DUP
        if (sp < 1) return done(2);
        if (sp === 256) return done(3);
        st[sp] = st[sp - 1];
        sp++;
        pc = next;
        break;
      case 5: // SWAP
        if (sp < 2) return done(2);
        { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; }
        pc = next;
        break;
      case 6: // OVER
        if (sp < 2) return done(2);
        if (sp === 256) return done(3);
        st[sp] = st[sp - 2];
        sp++;
        pc = next;
        break;
      case 7: // ROT: (a b c -- b c a)
        if (sp < 3) return done(2);
        { const a = st[sp - 3], b = st[sp - 2], c = st[sp - 1];
          st[sp - 3] = b; st[sp - 2] = c; st[sp - 1] = a; }
        pc = next;
        break;
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: {
        if (sp < 2) return done(2);
        const b = st[--sp];
        const a = st[--sp];
        let r;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) { if (b === 0) return done(4); r = Math.trunc(a / b) | 0; }
        else if (op === 20) { if (b === 0) return done(4); r = (a % b) | 0; }
        else if (op === 21) { if (b === 0) return done(4); r = Math.trunc((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 22) { if (b === 0) return done(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = (a << (b & 31)) | 0;
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        st[sp++] = r;
        pc = next;
        break;
      }
      case 23: // NEG (unary)
        if (sp < 1) return done(2);
        st[sp - 1] = (-st[sp - 1]) | 0;
        pc = next;
        break;
      case 27: // NOT (unary)
        if (sp < 1) return done(2);
        st[sp - 1] = ~st[sp - 1];
        pc = next;
        break;
      case 48: { // JMP: signed offset from the next instruction
        let off = prog[pc + 1] | (prog[pc + 2] << 8);
        if (off & 0x8000) off -= 0x10000;
        pc = next + off;
        break;
      }
      case 49: case 50: { // JZ / JNZ
        if (sp < 1) return done(2);
        const v = st[--sp];
        let off = prog[pc + 1] | (prog[pc + 2] << 8);
        if (off & 0x8000) off -= 0x10000;
        pc = (op === 49 ? v === 0 : v !== 0) ? next + off : next;
        break;
      }
      case 51: { // CALL: unsigned absolute target
        if (csp === 64) return done(7);
        cs[csp++] = next;
        pc = prog[pc + 1] | (prog[pc + 2] << 8);
        break;
      }
      case 52: // RET
        if (csp === 0) return done(8);
        pc = cs[--csp];
        break;
      case 64: { // LOAD
        if (sp < 1) return done(2);
        const addr = st[--sp];
        if (addr < 0 || addr > 255) return done(6);
        st[sp++] = mem[addr];
        pc = next;
        break;
      }
      case 65: { // STORE: ( v addr -- ), addr on top
        if (sp < 2) return done(2);
        const addr = st[--sp];
        const v = st[--sp];
        if (addr < 0 || addr > 255) return done(6);
        mem[addr] = v;
        pc = next;
        break;
      }
      case 80: { // PRINT: decimal ASCII, atomic against the output limit
        if (sp < 1) return done(2);
        const s = String(st[--sp]);
        if (olen + s.length > MAX_OUT) return done(11);
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        pc = next;
        break;
      }
      case 81: // PUTC
        if (sp < 1) return done(2);
        if (olen + 1 > MAX_OUT) return done(11);
        out[olen++] = st[--sp] & 255;
        pc = next;
        break;
      case 82: // IN: -1 once the input is used up, every time after
        if (sp === 256) return done(3);
        st[sp++] = iptr < input.length ? input[iptr++] : -1;
        pc = next;
        break;
      case 83: // EXIT: low byte of the popped value
        if (sp < 1) return done(2);
        return done(st[--sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const dir = join(I, id);
  if (!statSync(dir).isDirectory()) continue;
  const r = run(readFileSync(join(dir, 'program.bin')), readFileSync(join(dir, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), String(r.code) + '\n');
}
