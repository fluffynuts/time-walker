import yargs = require("yargs");

export interface CliOptions {
    at: string;
    dev: boolean;
    prod: boolean;
    seek: boolean;
    skip: string[];
    pretend: boolean;
    color: boolean;
    where: string;
}

export function gatherArgs(): CliOptions {
    const result = yargs.usage(`Usage: $0 [options], negate any boolean option by prepending --no`)
        .option("at", {
            description: "When to attempt to time-walk back to. Specify a date or a relative time, eg '3 days ago'",
            demandOption: true,
            type: "string"
        }).option("dev", {
            description: "apply to dev dependencies",
            boolean: true,
            default: true
        }).option("prod", {
            description: "apply to prod dependencies",
            boolean: true,
            default: true
        })
        .option("pretend", {
            description: "don't do anything, just show what would happen",
            alias: "p",
            boolean: true,
            default: false
        })
        .option("where", {
            description: "run at the specified path",
            default: process.cwd()
        }).option("color", {
            description: "output with pretty colors",
            boolean: true,
            default: true
        })
        .array("skip")
        // .option("seek", {
        //     description: "seek back in time in 1-day increments until npm test passes",
        //     boolean: true
        //     default: false
        // })
        .argv;
    return { ...result, skip: result.skip as string[], seek: false };
}

