import "datejs";
import { promises as fsPromises } from "fs";
import { spawn } from "child_process";
import { sync as which } from "which";
import { maxSatisfying } from "semver";
import { sync as rimraf } from "rimraf";
import { ExecStepContext } from "exec-step";
import yargs = require("yargs");

const { readFile } = fsPromises;

function die(message: string) {
    console.error(message);
    process.exit(1);
}


interface Dictionary<T> {
    [key: string]: T;
}

interface Package {
    dependencies: Dictionary<string>;
    devDependencies: Dictionary<string>;
}

interface CliOptions {
    at: string;
    dev: boolean;
    prod: boolean;
    seek: boolean;
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
        // .option("seek", {
        //     description: "seek back in time in 1-day increments until npm test passes",
        //     boolean: true,
        //     default: false
        // })
        .argv;
    return { ...result, seek: false };
}

export async function readPackageJson(): Promise<Package> {
    const raw = await readFile("package.json", { encoding: "utf-8" });
    try {
        return JSON.parse(raw as string) as Package;
    } catch (e) {
        die(`can't read package.json as json:\n${ raw }`);
        throw e;
    }
}

async function doInstall(
    ctx: ExecStepContext,
    packages: Dictionary<string>,
    atDate: Date,
    isDev: boolean) {
    const
        target = isDev ? "dev" : "prod";
    console.warn(`querying ${ target } packages`);
    const
        promises = Object.keys(packages)
            .map(pkg => findPackageVersionAt(pkg, packages[pkg], atDate)),
        answers = (await ctx.exec("fetching all package version info", () => Promise.all(promises))) as PkgInfo[],
        pkgArgs = answers
            .filter(a => a.version !== "unknown")
            .map(a => `${ a.pkg }@${ a.version }`),
        // handles when a package is installed from git (for now, no time-walking)
        urlArgs = Object.values(packages).filter(v => v.match(/:\/\//)),
        args = [ "install", isDev ? "--save-dev" : "--save", "--no-save" ].concat(pkgArgs).concat(urlArgs),
        delta = answers.map(a => {
            return {
                pkg: a.pkg,
                from: packages[a.pkg],
                to: a.version
            };
        }).filter(d => d.from.replace(/^\^/, "") !== d.to);

    await ctx.exec(`installing ${ delta.length } ${ target } packages`, () => execNpm(args, { passThrough: true }));
}

export async function installPackages(
    ctx: ExecStepContext,
    options: CliOptions,
    devPackages: Dictionary<string>,
    prodPackages: Dictionary<string>,
    atDate: Date) {
    if (options.dev) {
        await doInstall(ctx, devPackages, atDate, true);
    }
    if (options.prod) {
        await doInstall(ctx, prodPackages, atDate, true);
    }
}


function isVersionString(str: string): boolean {
    // very naive version-string matching
    return !!str.match(/^(\d\.|\d)+$/);
}

interface PkgInfo {
    pkg: string;
    version: string;
}

async function findPackageVersionAt(
    pkg: string,
    semver: string,
    when: Date
): Promise<{ pkg: string, version: string }> {
    const
        timeData = await execNpm([ "view", pkg, "time", "--json" ]),
        raw = JSON.parse(timeData.join("\n")) as Dictionary<string>,
        parsed = Object.keys(raw)
            .reduce((acc: Dictionary<Date>, cur: string) => {
                acc[cur] = Date.parse(raw[cur]);
                return acc;
            }, {} as Dictionary<Date>),
        pairs = Object.keys(parsed)
            .filter(isVersionString)
            .filter(ver => {
                // lock down to the semver in the package.json right now
                return !!maxSatisfying([ ver ], semver);
            })
            .map(k => ({ version: k, date: parsed[k] }))
            .sort((a, b) => {
                const
                    atime = a.date.getTime(),
                    btime = b.date.getTime();

                if (atime < btime) {
                    return -1;
                }
                return atime > btime ? 1 : 0;
            }),
        after = pairs.filter(p => p.date.getTime() >= when.getTime()),
        selected = after[0] || pairs[pairs.length - 1];
    return { pkg, version: selected ? selected.version : "unknown" };
}

async function runTests() {
    await execNpm([ "test" ], { passThrough: true });
}

let npmPath: string = "";

function execNpm(
    args: string[],
    opts?: ExecOpts
): Promise<string[]> {
    npmPath = npmPath || which("npm");
    return exec(npmPath, args, opts);
}

interface ExecOpts {
    passThrough: boolean;
}

function exec(
    cmd: string,
    args: string[],
    opts?: ExecOpts
): Promise<string[]> {
    opts = opts || {} as ExecOpts;
    const passThrough = !!opts.passThrough;

    return new Promise((resolve, reject) => {
        try {
            const
                errors = [] as string[],
                data = [] as string[],
                child = spawn(cmd, args);
            if (passThrough) {
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
            }
            child.stdout.on("data", d => {
                data.splice(data.length, 0, ...bufferToLines(d));
            });

            child.stderr.on("data", d => {
                errors.splice(data.length, 0, ...bufferToLines(d));
            });
            child.on("exit", code => code
                ? reject(new Error(`npm test dies with code: ${ code }\n${ errors.join("\n") }`))
                : resolve(data));
        } catch (e) {
            reject(new Error(`Unable to "): '${ cmd } ${ args.join(" ") }:\n${ e.message }`));
        }
    });
}

function bufferToLines(data: Buffer) {
    const str = data.toString();
    return str.split("\n").map((s: string) => s.replace(/\r$/, ""));
}

async function testsFail(): Promise<boolean> {
    try {
        await runTests();
        return false;
    } catch (e) {
        console.log(e.message);
        return true;
    }
}

export function clearNodeModules() {
    rimraf("node_modules");
}
