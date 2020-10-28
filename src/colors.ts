import { CliOptions } from "./gather-args";
import {
    redBright,
    yellowBright,
    cyanBright,
    greenBright
} from "ansi-colors";

export type Colorizer = (s: string) => string;

export interface ColorFunctions {
    redBright: Colorizer;
    yellowBright: Colorizer;
    cyanBright: Colorizer;
    greenBright: Colorizer;
}

const ansiColors: ColorFunctions = {
    redBright,
    yellowBright,
    cyanBright,
    greenBright
};

function passThrough(s: string) {
    return s;
}

const passThroughColors: ColorFunctions = {
    redBright: passThrough,
    yellowBright: passThrough,
    cyanBright: passThrough,
    greenBright: passThrough
};

export function colors(opts: CliOptions): ColorFunctions {
    return opts.color
        ? ansiColors
        : passThroughColors;
}
