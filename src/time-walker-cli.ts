#!/usr/bin/env node
import { ExecStepContext } from "exec-step";
import {
    clearNodeModules,
    installPackages,
    readPackageJson
} from "./time-walker";
import { gatherArgs } from "./gather-args";

(async () => {
    const
        start = process.cwd(),
        args = gatherArgs();
    try {
        process.chdir(args.where);
        const
            ctx = new ExecStepContext(),
            whenDate = Date.parse(args.at) as unknown as Date,
            pkg = await readPackageJson(),
            { dependencies, devDependencies } = pkg;

        if (!args.pretend) {
            ctx.exec("clear node_modules", () => clearNodeModules());
        }
        console.log(`installing packages as at ${ whenDate }`);
        await installPackages(ctx, args, devDependencies, dependencies, whenDate);
        // if (args.seek) {
        //     let offset = -1;
        //     while (await testsFail()) {
        //         ctx.exec("clear node_modules", () => clearNodeModules());
        //         // @ts-ignore
        //         await installPackages(ctx, args, devDependencies, dependencies, whenDate.add({ days: offset }));
        //         offset--;
        //     }
        // }
    } finally {
        process.chdir(start)
    }
})();
