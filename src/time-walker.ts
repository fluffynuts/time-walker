import "datejs";
import { promises as fsPromises } from "fs";
import { spawn } from "child_process";
import { sync as which } from "which";
import { maxSatisfying } from "semver";
import { sync as rimraf } from "rimraf";
import { ExecStepContext } from "exec-step";
import { Colorizer, colors } from "./colors";
import { CliOptions } from "./gather-args";
import debugFn = require("debug");
import bent = require("bent");
import pLimit = require("p-limit");
import os = require("os");
import path = require("path");

const { readFile, readdir } = fsPromises;
let yellowBright: Colorizer;
let redBright: Colorizer;
let greenBright: Colorizer;
let cyanBright: Colorizer;

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

async function findPackageJson() {
    let dir = process.cwd();
    while (true) {
        const contents = await readdir(dir);
        if (contents.includes("package.json")) {
            return path.join(dir, "package.json");
        }
        const next = path.dirname(dir);
        if (!next || next === dir) {
            throw new Error(`Unable to find a package.json in ${ process.cwd() } or in a parent folder`);
        }
        dir = path.dirname(dir);
    }
}

export async function readPackageJson(): Promise<Package> {
    const
        packageJsonFile = await findPackageJson(),
        raw = await readFile(packageJsonFile, { encoding: "utf-8" });
    try {
        return JSON.parse(raw as string) as Package;
    } catch (e) {
        die(`can't read package.json as json:\n${ raw }`);
        throw e;
    }
}

function isUrl(str: string): boolean {
    return !!str.match(/:\/\//);
}

function maxConcurrency() {
    const fromEnvironment = parseInt(process.env.MAX_CONCURRENCY || "", 10);
    return isNaN(fromEnvironment)
        ? Math.min(os.cpus().length, 4)
        : fromEnvironment
}

async function doInstall(
    ctx: ExecStepContext,
    packages: Dictionary<string>,
    pretend: boolean,
    skip: string[],
    atDate: Date,
    isDev: boolean
) {
    const
        target = isDev ? "dev" : "prod";
    console.log(yellowBright(`querying ${ target } packages`));
    const
        limit = pLimit(maxConcurrency()),
        packageNames = Object.keys(packages) as string[],
        promises = packageNames
            .map(pkg => limit(() => findPackageVersionAt(pkg, packages[pkg], atDate))),
        answers = (await ctx.exec("fetching all package version info", () => Promise.all(promises))) as PkgInfo[],
        pkgArgs = answers
            .filter(a => skip.indexOf(a.pkg) === -1)
            .filter(a => !!a.version)
            .map(a => `${ a.pkg }@${ a.version }`),
        skipped = packageNames.filter((n: string) => skip.indexOf(n) > -1),
        // handles when a package is installed from git (for now, no time-walking)
        urlArgs = Object.values(packages).filter(isUrl),
        args = [ "install", "--no-save", "--no-progress" ]
            .concat(pkgArgs) // calculated packages
            .concat(urlArgs) // url packages (just install what's there)
            .concat(skipped), // have to re-include skipped packages as at the current semver match
        changes = answers.map(a => {
            return {
                pkg: a.pkg,
                from: packages[a.pkg],
                to: a.version ?? "unknown",
                latest: a.latest
            };
        }),
        delta = changes.filter(d => d.latest !== d.to &&
            !isUrl(d.from) &&
            d.to !== "unknown"
        ),
        unknowns = changes.filter(d => d.to === "unknown" || isUrl(d.from));

    console.log(yellowBright(`package delta:`));
    delta.forEach(d => console.log(`${ cyanBright(d.pkg) }: ${ redBright(d.from) } => ${ greenBright(d.to) } (${ yellowBright(d.latest) })`))
    if (unknowns.length) {
        console.log(redBright(`some packages have 'unknown' target versions`));
        console.log(redBright(`  this happens with:`));
        console.log(redBright(`  - private packages`));
        console.log(redBright(`  - packages installed via url (eg from git)`));
        console.log(redBright(`unknowns will be installed at whatever semver resolves to:`))
        unknowns.forEach(d => console.log(`${ redBright(d.pkg) }: ${ redBright(d.from) }`));
    }

    if (pretend) {
        console.warn(yellowBright(`would run npm with: ${ args.join(" ") }`));
    } else {
        await ctx.exec(`installing ${ delta.length } ${ target } packages`, () => execNpm(args, { passThrough: false }));
    }
}

export async function installPackages(
    ctx: ExecStepContext,
    options: CliOptions,
    devPackages: Dictionary<string>,
    prodPackages: Dictionary<string>,
    atDate: Date) {
    const colorFunctions = colors(options);
    redBright = colorFunctions.redBright;
    yellowBright = colorFunctions.yellowBright;
    greenBright = colorFunctions.greenBright;
    cyanBright = colorFunctions.cyanBright;

    if (options.dev) {
        await doInstall(ctx, devPackages, options.pretend, options.skip, atDate, true);
    }
    if (options.prod) {
        await doInstall(ctx, prodPackages, options.pretend, options.skip, atDate, false);
    }
}


function isVersionString(str: string): boolean {
    // very naive version-string matching
    return !!str.match(/^(\d\.|\d)+(-.+)?$/);
}

interface PkgInfo {
    pkg: string;
    version: string;
    latest: string;
}

async function findPackageVersionAt(
    pkg: string,
    semver: string,
    when: Date,
    exclude?: Set<string>
): Promise<PkgInfo> {
    const
        debug = debugFn(`time-walker-${ pkg }`),
        parsed = await fetchPackageVersionTimes(pkg),
        pairs = Object.keys(parsed)
            .filter(isVersionString)
            .filter(ver => !(exclude?.has(ver)))
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
        before = pairs.filter(p => p.date.getTime() <= when.getTime()),
        latest = pairs[pairs.length - 1],
        selected = before[before.length - 1] || pairs[0];
    debug.log = console.log.bind(console); // allow tee'ing of output
    debug("parsed time data", parsed);
    debug("versions before cutoff date", before);
    debug("selected version", selected);
    if (!!selected) {
        if (!(await packageIsAvailableAtVersion(pkg, selected.version))) {
            debug(`${ pkg } is not available at version ${ selected.version }`);
            exclude = exclude ?? new Set<string>();
            exclude.add(selected.version);
            return findPackageVersionAt(pkg, semver, when, exclude);
        } else {
            debug(`${ pkg }@${ selected.version } is available!`);
        }
    }
    debug(`${ pkg } resolved to version ${ selected?.version ?? "none" } at ${ when } (latest semver match is ${ latest?.version ?? "unknown" })`);
    return {
        pkg,
        version: selected?.version,
        latest: latest?.version
    };
}

const packageVersionTimesCache = {} as Dictionary<Dictionary<Date>>

async function fetchPackageVersionTimes(
    pkg: string
): Promise<Dictionary<Date>> {
    const pkgInfo = await fetchPackageInfo(pkg);
    if (!pkgInfo) {
        return {};
    }
    const result = Object.keys(pkgInfo.time)
        .reduce((acc: Dictionary<Date>, cur: string) => {
            acc[cur] = Date.parse(pkgInfo.time[cur]);
            return acc;
        }, {} as Dictionary<Date>);
    return (packageVersionTimesCache[pkg] = result);
}


async function packageIsAvailableAtVersion(
    pkg: string,
    version: string): Promise<boolean> {
    if (isUrl(version)) {
        return true; // assume the url is available
    }
    const validVersions = await fetchPackageVersions(pkg);
    // assume the version is valid if we can't fetch -- perhaps a private package
    return validVersions?.has(version) ?? true;
}

const registryQuery = bent("https://registry.npmjs.org/", "GET", "json");

interface RegistryVersionInfo {
    name: string;
    version: string;
    description: string;
    main: string;
    // there are more, but I don't care
}

interface RegistryResult {
    name: string;
    versions: Dictionary<RegistryVersionInfo>;
    time: Dictionary<string>
}

const pkgQueryCache = {} as Dictionary<RegistryResult | null>;

async function fetchPackageVersions(pkg: string): Promise<Set<string> | null> {
    const pkgInfo = await fetchPackageInfo(pkg);
    return pkgInfo
        ? new Set(Object.keys(pkgInfo.versions))
        : null;
}

async function fetchPackageInfo(pkg: string): Promise<RegistryResult | null> {
    if (pkgQueryCache[pkg] === null) {
        return null;
    }
    const cached = pkgQueryCache[pkg];
    if (cached) {
        return cached;
    }
    try {
        return pkgQueryCache[pkg] = await registryQuery(pkg) as RegistryResult;
    } catch (e) {
        return pkgQueryCache[pkg] = null;
    }
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
