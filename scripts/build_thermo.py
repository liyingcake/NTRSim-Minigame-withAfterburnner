"""Generate the offline H/O equilibrium and frozen-nozzle table (Cantera 3.2).

python scripts/build_thermo.py --packages artifacts/cantera-runtime
No Python or Cantera is needed by the game after generation.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--packages', help='Optional local pip --target directory')
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(Path(args.packages).resolve()))
import cantera as ct
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'propulsion-config.json').read_text(encoding='utf-8'))
NAMES = ['H2', 'H', 'O2', 'O', 'OH', 'H2O', 'HO2', 'H2O2']
species = {s.name: s for s in ct.Species.list_from_file('nasa_gas.yaml')}
gas = ct.Solution(thermo='ideal-gas', species=[species[n] for n in NAMES])
water_ratio = gas.molecular_weights[2] / (2 * gas.molecular_weights[0])
ratios = [0, .025, .05, .1, .2, .35, .5, .75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, float(water_ratio), 8, 10, 12, 16]
pressures = [100, 200, 300, 1e3, 2e3, 3e3, 1e4, 3e4, 1e5, 3e5, 5e5, 1e6, 2e6, 3e6, 1e7, 3e7]
temperatures = sorted(set([200, 250, 293.15, 350] + list(range(400, 6001, 100))))
fields = ['h', 'cp', 'gamma', 'molarMass', 'formation', 'exitDrop', 'exitTemperature', 'injectionDrop', 'injectionTemperature'] + NAMES + ['equilibriumExitDrop', 'equilibriumExitTemperature']
formation = np.array([s.thermo.h(298.15) / mw for s, mw in zip(gas.species(), gas.molecular_weights)])
exit_pressure = config['exitPressure']

def frozen_expansion(y, entropy, enthalpy, pressure):
    """Frozen composition, constant entropy. Below 200 K continue cp(200 K)."""
    gas.TPY = 200, pressure, y
    if entropy < gas.entropy_mass:
        cp = gas.cp_mass
        temperature = 200 * np.exp((entropy - gas.entropy_mass) / cp)
        h_exit = gas.enthalpy_mass + cp * (temperature - 200)
    else:
        gas.SP = entropy, pressure
        temperature, h_exit = gas.T, gas.enthalpy_mass
    return max(0, enthalpy - h_exit), temperature

def feed_enthalpy(fluid, component, temperature):
    # Align the pure-fluid enthalpy reference to the NASA gas reference at 500 K.
    gas.TPY = 500, ct.one_atm, {component: 1}
    reference = gas.enthalpy_mass
    fluid.TP = 500, ct.one_atm
    offset = reference - fluid.enthalpy_mass
    fluid.TP = temperature, ct.one_atm
    return float(fluid.enthalpy_mass + offset)

feeds = {
    'hydrogen': feed_enthalpy(ct.Hydrogen(), 'H2', 20),
    'oxygen': feed_enthalpy(ct.Oxygen(), 'O2', 90),
    'water': feed_enthalpy(ct.Water(), 'H2O', 293.15)
}
cold_exits = {}
for ratio in ratios:
    gas.TPY = 200, exit_pressure, {'H2': 1, 'O2': ratio}
    gas.equilibrate('TP', solver='auto', rtol=1e-9, max_steps=5000)
    cold_exits[ratio] = (gas.Y.copy(), gas.entropy_mass, gas.enthalpy_mass, gas.cp_mass)
values = []
for pressure in pressures:
    for ratio in ratios:
        initial = {'H2': 1, 'O2': ratio}
        for temperature in temperatures:
            gas.TPY = temperature, pressure, initial
            try:
                gas.equilibrate('TP', solver='auto', rtol=1e-9, max_steps=5000)
            except ct.CanteraError:
                gas.TPY = temperature, pressure, initial
                gas.equilibrate('TP', solver='vcs', rtol=1e-9, max_steps=20000)
            y = gas.Y.copy()
            h, entropy = gas.enthalpy_mass, gas.entropy_mass
            cp, gamma, molar = gas.cp_mass, gas.cp_mass / gas.cv_mass, gas.mean_molecular_weight
            exit_drop, exit_t = frozen_expansion(y, entropy, h, min(pressure, exit_pressure))
            injection_drop, injection_t = frozen_expansion(y, entropy, h, pressure * config['injectionPressureRatio'])
            # Equilibrium nozzle is a separate upper-performance reference. At
            # low T, radicals are negligible and the frozen continuation suffices.
            cold_y, cold_s, cold_h, cold_cp = cold_exits[ratio]
            if entropy <= cold_s:
                equilibrium_t = 200 * np.exp((entropy - cold_s) / cold_cp)
                equilibrium_drop = max(0, h - cold_h - cold_cp * (equilibrium_t - 200))
            else:
                gas.TPY = 200, min(pressure, exit_pressure), y
                if entropy < gas.entropy_mass:
                    gas.TPY = 200, min(pressure, exit_pressure), cold_y
                try:
                    gas.SP = entropy, min(pressure, exit_pressure)
                    gas.equilibrate('SP', solver='auto', rtol=1e-8, max_steps=5000)
                except ct.CanteraError:
                    # Robust entropy root, always inside the polynomial domain.
                    low, high = 200.0, 6000.0
                    for _ in range(22):
                        mid = (low + high) / 2
                        gas.TPY = mid, min(pressure, exit_pressure), initial
                        gas.equilibrate('TP', solver='auto', rtol=1e-9, max_steps=5000)
                        if gas.entropy_mass > entropy:
                            high = mid
                        else:
                            low = mid
                equilibrium_drop, equilibrium_t = max(0, h - gas.enthalpy_mass), gas.T
            values.extend([h, cp, gamma, molar, float(y @ formation), exit_drop, exit_t, injection_drop, injection_t, *y.tolist(), equilibrium_drop, equilibrium_t])
    print(f'Generated equilibrium and frozen expansion: {pressure / 1e6:g} MPa', flush=True)

data_path = next(Path(directory) / 'nasa_gas.yaml' for directory in ct.get_data_directories() if (Path(directory) / 'nasa_gas.yaml').exists())
metadata = {
    'version': 1, 'generator': 'scripts/build_thermo.py', 'cantera': ct.__version__,
    'source': 'Cantera nasa_gas.yaml / NASA TM-4513 thermodynamic polynomials',
    'sourceSHA256': hashlib.sha256(data_path.read_bytes()).hexdigest(),
    'species': NAMES, 'fields': fields, 'pressures': pressures, 'ratios': ratios,
    'temperatures': temperatures, 'waterRatio': float(water_ratio),
    'molecularWeights': gas.molecular_weights.tolist(), 'formationEnthalpies': formation.tolist(),
    'speciesThermo': [s.thermo.coeffs.tolist() for s in gas.species()],
    'exitPressure': exit_pressure, 'injectionPressureRatio': config['injectionPressureRatio'], 'model': config, 'feedEnthalpy': feeds,
    'units': 'Pa, K, J/kg, J/(kg K), kg/kmol, species mass fractions',
    'assumptions': '8 neutral ideal-gas H/O species; TP equilibrium; frozen and equilibrium isentropic nozzle references; cp(200 K) continuation below 200 K; no ions or finite-rate kinetics',
    'sources': ['https://cantera.org/stable/python/thermo.html', 'https://cantera.org/stable/examples/python/thermo/isentropic.html', 'https://ntrs.nasa.gov/citations/19940013151']
}
encoded = base64.b64encode(np.asarray(values, dtype='<f4').tobytes()).decode('ascii')
output = '// Generated offline by scripts/build_thermo.py. Do not edit.\n(function(root){\n'
output += 'const metadata=' + json.dumps(metadata, separators=(',', ':')) + ';\n'
output += 'const encoded="' + encoded + '";\n'
output += "let data;function getData(){if(!data){if(typeof Buffer!=='undefined'){const b=Buffer.from(encoded,'base64');data=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);}else{const raw=atob(encoded),b=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);data=new Float32Array(b.buffer);}}return data;}\n"
output += "const api={metadata,getData};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NTR_THERMO_TABLE=api;\n})(typeof window!=='undefined'?window:globalThis);\n"
(ROOT / 'thermo-table.js').write_text(output, encoding='utf-8')
(ROOT / 'benchmarks' / 'thermo-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
print(f'Wrote {len(values)} float32 values, {len(output):,} bytes; feed enthalpies {feeds}')
