"""Independent Cantera entropy / frozen expansion / reaction-time references."""
import argparse
import json
from pathlib import Path
import sys

p = argparse.ArgumentParser()
p.add_argument('--packages')
args = p.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import cantera as ct

names = ['H2', 'H', 'O2', 'O', 'OH', 'H2O', 'HO2', 'H2O2']
species = {s.name: s for s in ct.Species.list_from_file('nasa_gas.yaml')}
gas = ct.Solution(thermo='ideal-gas', species=[species[n] for n in names])
kinetics = ct.Solution('h2o2.yaml')
cases = []
for temperature, pressure, ratio in [(3000, 5e5, 0), (3100, 3e5, 0), (2500, 3e6, 2), (3500, 1e6, 8), (1800, 1e6, 7.936011904761905)]:
    gas.TPY = temperature, pressure, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', rtol=1e-10)
    y, entropy, h = gas.Y.copy(), gas.entropy_mass, gas.enthalpy_mass
    kinetics.TPY = temperature, pressure, dict(zip(names, y))
    index = kinetics.species_index('H')
    destruction = kinetics.destruction_rates[index] * kinetics.molecular_weights[index] / kinetics.density
    tau = .5 * y[1] / destruction if destruction > 1e-30 else 1e6
    gas.SP = entropy, pressure / 30
    cases.append({'temperature': temperature, 'pressure': pressure, 'ratio': ratio, 'y': y.tolist(), 'entropy': entropy,
                  'h': h, 'reactionTime': float(tau), 'frozenPressure': pressure / 30, 'frozenTemperature': gas.T,
                  'frozenH': gas.enthalpy_mass, 'frozenCp': gas.cp_mass})
target = Path(__file__).resolve().parents[1] / 'benchmarks/nozzle-reference.json'
target.write_text(json.dumps({'cantera': ct.__version__, 'cases': cases}, indent=2) + '\n', encoding='utf-8')
print('Saved independent nozzle references.')
