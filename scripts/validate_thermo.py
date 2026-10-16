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
random.seed(1963024)
cases = []
points = [(2500, 4e6, 0), (3100, 4e6, 7.936011904761905), (4800, 1e6, 2), (5500, 3e5, 8)]
points += [(random.uniform(500, 5600), 10 ** random.uniform(4, 7), random.uniform(0, 8)) for _ in range(128)]
for temperature, pressure, ratio in points:
    gas.TPY = temperature, pressure, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', solver='auto', rtol=1e-9, max_steps=5000)
    h, y, entropy = gas.enthalpy_mass, gas.Y.copy(), gas.entropy_mass
    gas.TPY = 200, 2000, y
    if entropy < gas.entropy_mass:
        t_exit = 200 * __import__('math').exp((entropy - gas.entropy_mass) / gas.cp_mass)
        h_exit = gas.enthalpy_mass + gas.cp_mass * (t_exit - 200)
    else:
        gas.SP = entropy, 2000
        h_exit, t_exit = gas.enthalpy_mass, gas.T
    frozen_drop = h - h_exit
    if temperature < 800 or t_exit < 200:
        equilibrium_drop = frozen_drop
    else:
        gas.TPY = temperature, pressure, y
        gas.SP = entropy, 2000
        gas.equilibrate('SP', solver='auto', rtol=1e-8, max_steps=5000)
        equilibrium_drop = h - gas.enthalpy_mass
    cases.append({'temperature': temperature, 'pressure': pressure, 'ratio': ratio, 'h': h, 'y': y.tolist(), 'exitDrop': frozen_drop, 'equilibriumExitDrop': equilibrium_drop})
output = Path(__file__).resolve().parents[1] / 'benchmarks' / 'thermo-reference.json'
metadata = json.loads((output.parent / 'thermo-metadata.json').read_text(encoding='utf-8'))
lantr = []
for ratio in [0, 1, 3, metadata['waterRatio']]:
    main, oxygen, pressure, wall = 10, ratio * 10, 4e6, 650
    flow, mix_pressure = main + oxygen, pressure * .18
    gas.TPY = 2500, pressure, {'H2': 1}
    gas.equilibrate('TP', rtol=1e-9, max_steps=5000)
    primary_h, primary_s = gas.enthalpy_mass, gas.entropy_mass
    gas.SP = primary_s, mix_pressure  # Frozen first expansion.
    retained = .96 * (primary_h - gas.enthalpy_mass) * (main / flow) ** 2
    input_power = main * primary_h + oxygen * metadata['feedEnthalpy']['oxygen']
    gas.TPY = 2500, mix_pressure, {'H2': 1, 'O2': ratio}
    gas.HP = input_power / flow - retained, mix_pressure
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    difference = max(0, gas.T - wall)
    limit = flow * gas.cp_mass * difference * .08
    heat = limit * math.tanh(6000 * (flow / 16) ** .35 * difference / limit)
    gas.HP = gas.enthalpy_mass - heat / flow, mix_pressure
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    mix_t, mix_y, mix_h, mix_s = gas.T, gas.Y.copy(), gas.enthalpy_mass, gas.entropy_mass
    gas.SP = mix_s, 2000
    gas.equilibrate('SP', rtol=1e-9, max_steps=5000)
    drop = mix_h - gas.enthalpy_mass
    kinetic = retained + .96 * drop
    gas.HP = mix_h - .96 * drop, 2000
    gas.equilibrate('HP', rtol=1e-9, max_steps=5000)
    jet = math.sqrt(2 * kinetic)
    pressure_velocity = ct.gas_constant / gas.mean_molecular_weight * gas.T / jet
    lantr.append({'ratio': ratio, 'mixK': mix_t, 'exitK': gas.T, 'mixY': mix_y.tolist(), 'exitY': gas.Y.tolist(),
                  'jetVelocityMS': jet, 'ispS': (jet + pressure_velocity) / 9.80665, 'wallMW': heat / 1e6})
output.write_text(json.dumps({'cantera': ct.__version__, 'seed': 1963024, 'cases': cases, 'lantr': lantr}, indent=2) + '\n', encoding='utf-8')
print(f'Wrote {len(cases)} independent Cantera states')
