"""Independent neutral-hydrogen audit. No gameplay parameters are changed."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--packages')
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import cantera as ct

root = Path(__file__).resolve().parents[1]
names = ['H2', 'H', 'O2', 'O', 'OH', 'H2O', 'HO2', 'H2O2']
species = {s.name: s for s in ct.Species.list_from_file('nasa_gas.yaml')}
gas = ct.Solution(thermo='ideal-gas', species=[species[n] for n in names])
reference = []
for temperature in [2820, 3000]:
    for pressure in [1e6, 5e5, 1e5, 1e4]:
        gas.TPY = temperature, pressure, {'H2': 1}
        gas.equilibrate('TP', rtol=1e-10)
        reference.append({'gasTemperature': temperature, 'pressurePa': pressure, 'hMassFraction': float(gas['H'].Y[0]),
                          'hMoleFraction': float(gas['H'].X[0]), 'molarMass': gas.mean_molecular_weight, 'enthalpy': gas.enthalpy_mass})
runtime = json.loads(subprocess.check_output(['node', '-e', """
const t=require('./thermochemistry.js'), {NTRSimulation}=require('./simulation.js');
const fixedTemperature=[],fixedEnthalpy=[],h=t.atTemperature(3000,1e6).h;
for(const p of [1e6,5e5,1e5,1e4]){
  const s=t.atTemperature(3000,p),hp=t.fromEnthalpy(h,p),e=t.exhaust(10,0,3000,p/1e6,650),f=t.exhaust(10,0,hp.temperature,p/1e6,650);
  fixedTemperature.push({gasTemperature:3000,pressurePa:p,hMassFraction:s.y[1],molarMass:s.molarMass,enthalpy:s.h,isp:e.velocity/9.80665,exitH:e.fractions.H,energyResidualMW:e.energy.residual});
  fixedEnthalpy.push({gasTemperature:hp.temperature,pressurePa:p,hMassFraction:hp.y[1],enthalpy:hp.h,isp:f.velocity/9.80665});
}
const core=new NTRSimulation(); core.reset(true); core.coreTemperature=3000;
core.flow=core.ratedFlow*.5/5.8/Math.sqrt(2820/2600); core.updatePerformance();
console.log(JSON.stringify({fixedTemperature,fixedEnthalpy,core3000WithoutRegeneration:{coreTemperature:core.coreTemperature,gasTemperature:core.thermoState.primaryTemperature,pressureMPa:core.pressure,flow:core.flow,hMassFraction:core.thermoState.primaryFractions.H,isp:core.isp}}));
"""], cwd=root, text=True))
data = {'version': '0.9.0', 'canteraVersion': ct.__version__, 'species': names,
        'interpretation': 'Neutral H2 <=> 2H equilibrium; no ions. Equal temperature does not imply equal required heating energy. Core metal temperature differs from propellant gas temperature.',
        'reference': reference, **runtime}
target = root / 'benchmarks' / 'v0.9-hydrogen-audit.json'
target.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
print(target.name)
print(json.dumps(runtime, indent=2))
