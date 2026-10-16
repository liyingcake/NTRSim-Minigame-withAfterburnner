"""Independent Cantera TP/HP oracle cases for the runtime interpolator."""
import argparse
import json
from pathlib import Path
import random
import sys
import math
parser = argparse.ArgumentParser()
parser.add_argument('--packages')
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import cantera as ct
names = ['H2', 'H', 'O2', 'O', 'OH', 'H2O', 'HO2', 'H2O2']
species = {s.name: s for s in ct.Species.list_from_file('nasa_gas.yaml')}
gas = ct.Solution(thermo='ideal-gas', species=[species[n] for n in names])
output = Path(__file__).resolve().parents[1] / 'benchmarks' / 'thermo-reference.json'
metadata = json.loads((output.parent / 'thermo-metadata.json').read_text(encoding='utf-8'))
pe = metadata['exitPressure']
model = metadata['model']

def equilibrium_exit(entropy, pressure, ratio):
    gas.TPY = 200, pressure, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', rtol=1e-9, max_steps=5000)
    if entropy < gas.entropy_mass:
        t = 200 * math.exp((entropy - gas.entropy_mass) / gas.cp_mass)
        return gas.enthalpy_mass + gas.cp_mass * (t - 200)
    low, high = 200, 6000
    for _ in range(26):
        gas.TPY = (low + high) / 2, pressure, {'H2': 1, 'O2': ratio}
        gas.equilibrate('TP', rtol=1e-9, max_steps=5000)
        if gas.entropy_mass > entropy: high = gas.T
        else: low = gas.T
    return gas.enthalpy_mass

random.seed(1963024)
cases = []
points = [(2500, 4e6, 0), (3100, 4e6, 7.936011904761905), (4800, 1e6, 2), (5500, 3e5, 8)]
points += [(random.uniform(500, 5600), 10 ** random.uniform(4, 7), random.uniform(0, 8)) for _ in range(128)]
for temperature, pressure, ratio in points:
    gas.TPY = temperature, pressure, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', solver='auto', rtol=1e-9, max_steps=5000)
    h, y, entropy = gas.enthalpy_mass, gas.Y.copy(), gas.entropy_mass
    gas.TPY = 200, pe, y
    if entropy < gas.entropy_mass:
        t_exit = 200 * __import__('math').exp((entropy - gas.entropy_mass) / gas.cp_mass)
        h_exit = gas.enthalpy_mass + gas.cp_mass * (t_exit - 200)
    else:
        gas.SP = entropy, pe
        h_exit, t_exit = gas.enthalpy_mass, gas.T
    frozen_drop = h - h_exit
    equilibrium_drop = h - equilibrium_exit(entropy, pe, ratio)
    cases.append({'temperature': temperature, 'pressure': pressure, 'ratio': ratio, 'h': h, 'y': y.tolist(), 'exitDrop': frozen_drop, 'equilibriumExitDrop': equilibrium_drop})
lantr = []
for ratio, regen in [(0, 0), (1, 0), (3, 0), (metadata['waterRatio'], 0), (3, 10e6)]:
    main, oxygen, pressure, wall = 10, ratio * 10, 4e6, 650
    flow, mix_pressure = main + oxygen, pressure * model['injectionPressureRatio']
    gas.TPY = 2500, pressure, {'H2': 1}
    gas.equilibrate('TP', rtol=1e-9, max_steps=5000)
    gas.HP = gas.enthalpy_mass + regen / main, pressure
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    primary_h, primary_s = gas.enthalpy_mass, gas.entropy_mass
    gas.SP = primary_s, mix_pressure  # Frozen first expansion.
    retained = model['kineticEfficiency'] * (primary_h - gas.enthalpy_mass) * (main / flow) ** 2
    input_power = main * primary_h + oxygen * metadata['feedEnthalpy']['oxygen']
    gas.TPY = 2500, mix_pressure, {'H2': 1, 'O2': ratio}
    gas.HP = input_power / flow - retained, mix_pressure
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    difference = max(0, gas.T - wall)
    limit = flow * gas.cp_mass * difference * .08
    heat = limit * math.tanh(6000 * (flow / model['hydrogenRatedFlow']) ** .35 * difference / limit)
    gas.HP = gas.enthalpy_mass - heat / flow, mix_pressure
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    mix_t, mix_y, mix_h, mix_s = gas.T, gas.Y.copy(), gas.enthalpy_mass, gas.entropy_mass
    drop = mix_h - equilibrium_exit(mix_s, pe, ratio)
    kinetic = retained + model['kineticEfficiency'] * drop
    exit_h = mix_h - model['kineticEfficiency'] * drop
    gas.TPY = 200, pe, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', rtol=1e-9, max_steps=5000)
    if exit_h < gas.enthalpy_mass:
        exit_t = 200 + (exit_h - gas.enthalpy_mass) / gas.cp_mass
    else:
        gas.HP = exit_h, pe
        gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
        exit_t = gas.T
    jet = math.sqrt(2 * kinetic)
    pressure_velocity = ct.gas_constant / gas.mean_molecular_weight * exit_t / jet
    lantr.append({'ratio': ratio, 'regenerativeMW': regen / 1e6, 'mixK': mix_t, 'exitK': exit_t, 'mixY': mix_y.tolist(), 'exitY': gas.Y.tolist(),
                  'jetVelocityMS': jet, 'ispS': (jet + pressure_velocity) / 9.80665, 'wallMW': heat / 1e6})
output.write_text(json.dumps({'cantera': ct.__version__, 'seed': 1963024, 'cases': cases, 'lantr': lantr}, indent=2) + '\n', encoding='utf-8')
print(f'Wrote {len(cases)} independent Cantera states')
