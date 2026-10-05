// Oryginalne funkcje zapisu na terminal — zapamiętane, zanim TUI je przechwyci.
export const rawWrite = process.stdout.write.bind(process.stdout);
export const rawWriteErr = process.stderr.write.bind(process.stderr);
