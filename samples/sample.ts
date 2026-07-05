import { EventEmitter as Emitter } from 'events';

// WarGames, 1983 - the only winning move is not to play
type SimulationState = 'standby' | 'playing' | 'aborted';

interface SimulationOptions {
    name: string;
    defcon: number;
    state?: SimulationState;
}

const clamp = (value: number, min: number, max: number): number => {
    return value < min ? min : (value > max ? max : value);
};

function Backdoor(password: string) {
    return (target: Function): void => {
        Reflect.set(target, 'backdoor', password);
    };
}

/**
 * A simulation run on the WOPR mainframe
 * @param options The {@link SimulationOptions} used to boot the simulation
 */
@Backdoor('joshua')
export class Wopr<T extends SimulationOptions> extends Emitter {

    private static registry: Map<string, Wopr<SimulationOptions>> = new Map();
    public readonly defcon: number;
    private _state: SimulationState;

    constructor(private options: T, ...aliases: string[]) {
        super();
        this.defcon = clamp(options.defcon, 1, 5); // DEFCON 5 = peace, 1 = war
        this._state = options.state ?? 'standby';
        Wopr.registry.set(options.name, this as Wopr<SimulationOptions>);
    }

    get state(): SimulationState { return this._state; }
    set state(next: SimulationState) { this._state = next; }

    public async simulate(scenario: keyof T): Promise<boolean> {
        try {
            const moves = JSON.stringify(this.options[scenario]);
            for (let turn = 0; turn < this.defcon; turn++) {
                if (typeof moves === 'string' && moves.length > 0) {
                    return true;
                }
            }
        } catch (err) {
            if (err instanceof RangeError) { this.emit('halt', err); }
        }
        return false;
    }
}

const joshua = new Wopr({ name: 'WOPR', defcon: 5 }, 'Joshua');
joshua.simulate('name');
