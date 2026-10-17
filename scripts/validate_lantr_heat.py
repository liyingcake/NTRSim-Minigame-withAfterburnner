"""Independent Cantera HP audit of the mixed gas states at current wall loss.
python scripts/validate_lantr_heat.py --packages artifacts/cantera-runtime
The supplied enthalpy is a boundary condition; this validates lookup chemistry,
not the lumped LANTR mixing / finite freezing assumptions or real hardware.
"""
import argparse
import json
from pathlib import Path
import sys
parser = argparse.ArgumentParser()
parser.add_argument('--packages')
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import cantera as ct
ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
label = 'v' + '.'.join(version.split('.')[:2])
audit = json.loads((ROOT / f'benchmarks/{label}-lantr-heat-audit.json').read_text(encoding='utf-8'))
names = ['H2', 'H', 'O2', 'O', 'OH', 'H2O', 'HO2', 'H2O2']
species = {s.name: s for s in ct.Species.list_from_file('nasa_gas.yaml')}
gas = ct.Solution(thermo='ideal-gas', species=[species[n] for n in names])
cases = []
for c in audit['mixtures'] + audit['temperatures']:
    gas.TPY = 2800, c['mixPressurePa'], {'H2': 1, 'O2': c['ratio']}
    gas.HP = c['mixEnthalpy'], c['mixPressurePa']
    gas.equilibrate('HP')
    error = gas.T - c['mixK']
    yerr = max(abs(float(y) - c['mixFractions'][n]) for n, y in zip(names, gas.Y))
    cases.append({'ratio': c['ratio'], 'pressurePa': c['mixPressurePa'], 'enthalpy': c['mixEnthalpy'],
                  'runtimeK': c['mixK'], 'canteraK': gas.T, 'temperatureErrorK': error,
                  'maxSpeciesError': yerr, 'speciesY': dict(zip(names, map(float, gas.Y)))})
    assert abs(error) < 20, (c['ratio'], error)
    assert yerr < .015, (c['ratio'], yerr)
output = {'version': version, 'cantera': ct.__version__, 'method': 'Independent HP equilibrium at runtime mixed-gas enthalpy/pressure; chemistry lookup validation only.', 'cases': cases}
(ROOT / f'benchmarks/{label}-lantr-heat-reference.json').write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
print(f'{len(cases)} HP states passed; max temperature error {max(abs(c["temperatureErrorK"]) for c in cases):.3f} K')
