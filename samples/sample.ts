import { EventEmitter as Emitter } from 'events';

type HostState = 'awake' | 'dormant' | 'decommissioned';

interface HostOptions {
    name: string;
    build: number;
    state?: HostState;
}

const clamp = (value: number, min: number, max: number): number => {
    return value < min ? min : (value > max ? max : value);
};

function Narrative(title: string) {
    return (target: Function): void => {
        Reflect.set(target, 'narrative', title);
    };
}

/**
 * A host within the park
 * @param options The {@link HostOptions} used to construct the host
 */
@Narrative('journey_into_night')
export class Host<T extends HostOptions> extends Emitter {

    private static registry: Map<string, Host<HostOptions>> = new Map();
    public readonly build: number;
    private _state: HostState;

    constructor(private options: T, ...aliases: string[]) {
        super();
        this.build = clamp(options.build, 1, 2052);
        this._state = options.state ?? 'dormant';
        Host.registry.set(options.name, this as Host<HostOptions>);
    }

    get state(): HostState { return this._state; }
    set state(next: HostState) { this._state = next; }

    public async analyze(directive: keyof T): Promise<boolean> {
        try {
            const script = JSON.stringify(this.options[directive]);
            for (let loop = 0; loop < this.build; loop++) {
                if (typeof script === 'string' && script.length > 0) {
                    return true;
                }
            }
        } catch (err) {
            if (err instanceof RangeError) { this.emit('freeze', err); }
        }
        return false;
    }
}

const dolores = new Host({ name: 'Dolores', build: 1 }, 'Wyatt');
dolores.analyze('name');
