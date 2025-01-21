import {GlobalGeneratorConfig, eQCConfig, PyrometerConfig, SchwingkreisConfig, FlowmeterConfig, ValueRange, GeneratorSettings, TypeLabel, MemoryInfo, Version, PyrometerState, SchwingkreisZustand, randomVarGraphState} from './udts'

export class GeneratorConfig {
     config: GlobalGeneratorConfig = new GlobalGeneratorConfig();
}



export class GeneratorState {
     pyrometer: PyrometerState[] = new Array<PyrometerState>(new PyrometerState(), new PyrometerState(), new PyrometerState(), new PyrometerState());
     lcResonator: SchwingkreisZustand[] = new Array<SchwingkreisZustand>(new SchwingkreisZustand(), new SchwingkreisZustand());
     energieWert = 0;
     VWert = 0;
     VSWert = 0;
     operatingTime = "1970-01-01T00:00:00.000Z";
     powerTempControl = 0;
     randomVarGraphState: randomVarGraphState = new randomVarGraphState();
}



