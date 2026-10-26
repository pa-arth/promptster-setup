#!/usr/bin/env node
// The executable. Kept to three lines so that importing anything else in this
// package can never run the installer as a side effect of a module load.
import { main } from './cli.js';

main();
