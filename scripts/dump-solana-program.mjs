#!/usr/bin/env node
/**
 * Saves a deployed Solana program's binary (an upgradeable BPF program's
 * ELF) to a .so file, over plain RPC, for local tests (LiteSVM,
 * solana-test-validator --bpf-program) that need a protocol's real code.
 * Same result as `solana program dump`, without the Solana CLI.
 *
 *   node scripts/dump-solana-program.mjs <program id> <out.so> [rpc url]
 */
import fs from "node:fs";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const [id, out, rpc] = process.argv.slice(2);
if (!id || !out) {
  console.error("Usage: dump-solana-program.mjs <program id> <out.so> [rpc url]");
  process.exit(2);
}
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
// bpf_loader_upgradeable's account layouts: Program { u32 tag = 2, programdata: Pubkey }; ProgramData { u32 tag = 3,
// slot: u64, upgrade authority: Option<Pubkey> (1 + 32) }, then the ELF.
const PROGRAMDATA_HEADER = 4 + 8 + 1 + 32;

const connection = new Connection(rpc || clusterApiUrl("mainnet-beta"), "confirmed");
const program = await connection.getAccountInfo(new PublicKey(id));
if (!program?.executable) throw new Error(`${id} isn't a deployed program`);
if (program.owner.toBase58() !== UPGRADEABLE_LOADER) throw new Error(`${id} isn't an upgradeable program (owner ${program.owner.toBase58()})`);
if (program.data.readUInt32LE(0) !== 2) throw new Error(`${id}: unexpected program account`);
const programData = new PublicKey(program.data.subarray(4, 36));
const data = await connection.getAccountInfo(programData);
if (!data || data.data.readUInt32LE(0) !== 3) throw new Error(`${id}: unexpected program data account ${programData.toBase58()}`);
const elf = data.data.subarray(PROGRAMDATA_HEADER);
if (elf.subarray(0, 4).toString("latin1") !== "\x7fELF") throw new Error(`${id}: program data doesn't start with an ELF header`);
fs.writeFileSync(out, elf);
console.log(`${id} -> ${out} (${elf.length} bytes, deployed at slot ${data.data.readBigUInt64LE(4)})`);
