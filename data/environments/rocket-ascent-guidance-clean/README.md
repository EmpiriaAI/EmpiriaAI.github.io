# Ascent Guidance Specification (authoritative)

This document is the complete, self-contained definition of the launch-vehicle flight
dynamics used in this workspace. The flight software was lost; this specification is
the only authority. Any conforming trajectory propagator must implement exactly the
model below. All formulas are given explicitly so that two independent implementations
agree to numerical integration accuracy (relative state agreement ~1e-8 or better for
any adaptive integrator run at rtol 1e-9 or tighter).

A guidance **plan** (see `plan_schema.json`) commands a launch azimuth, a pitch
program, and an upper-stage burn/coast schedule. Flown through the dynamics below, a
plan produces one deterministic trajectory. Your job is to produce plans that reach a
target circular orbit.

---

## 1. Reference frames and constants

**Inertial frame (ECI, frame F).** Right-handed Cartesian frame with origin at the
Earth's center of mass:

- `+Z` is the Earth's rotation axis, positive north.
- `+X` lies in the equatorial plane and passes through the Greenwich meridian at
  time `t = 0`.
- `+Y` completes the right-handed triad.

The Earth is a sphere of radius `R` rotating rigidly about `+Z` at rate `omega`
(rad/s), so a point fixed on the Earth at ECI position `p0` at `t = 0` is at ECI
position `Rz(omega * t) @ p0` at time `t`, where `Rz(a)` is the rotation about `+Z`
by angle `a` (counterclockwise seen from +Z):

```
Rz(a) = [[cos a, -sin a, 0],
         [sin a,  cos a, 0],
         [0,      0,     1]]
```

The Earth's angular-velocity vector is `W = (0, 0, omega)`.

All state vectors below are expressed in frame F. Gravity is spherical
(no J2, no third bodies):

```
a_grav = -mu * r / |r|^3
```

## 2. Problem instance format

Each problem is a JSON object (see `examples/problem_example.json`):

```json
{
  "problem_id": "...",
  "constants": {"mu": ..., "omega": ..., "R_earth": ..., "g0": ...},
  "site":      {"latitude_deg": ..., "longitude_deg": ..., "altitude_m": ...},
  "target":    {"altitude_m": ..., "inclination_deg": ...},
  "vehicle": {
    "stage1": {"thrust_N": ..., "isp_s": ..., "dry_mass_kg": ..., "propellant_mass_kg": ...},
    "stage2": {"thrust_N": ..., "isp_s": ..., "dry_mass_kg": ..., "propellant_mass_kg": ...},
    "separation_delay_s": ...,
    "drag_coefficient": ...,
    "reference_area_m2": ...
  },
  "atmosphere": {"altitude_m": [...], "density_kg_m3": [...]},
  "q_limit_pa": ...
}
```

Units are SI throughout: metres, seconds, kilograms, newtons, pascals.
`g0 = 9.80665 m/s^2` is the *constant* used in the mass-flow relation only
(it is not the local gravitational acceleration).

- `site.latitude_deg` (geocentric = geodetic here, spherical Earth) and
  `site.longitude_deg` (positive east of Greenwich) locate the launch pad;
  `site.altitude_m` is the pad altitude above the sphere of radius `R_earth`.
- `target` defines a *circular* orbit: the target apoapsis altitude AND target
  periapsis altitude both equal `target.altitude_m`; the target inclination is
  `target.inclination_deg`.
- `q_limit_pa` bounds peak dynamic pressure (Section 7).
- `atmosphere.altitude_m` is strictly increasing, starts at 0, and ends at or
  above 140 km; `density_kg_m3` is strictly decreasing.

## 3. Initial conditions at liftoff (t = 0)

With `phi = radians(site.latitude_deg)`, `lam = radians(site.longitude_deg)`,
`r0_len = R_earth + site.altitude_m`:

```
r(0) = r0_len * [cos(phi) cos(lam), cos(phi) sin(lam), sin(phi)]
v(0) = W x r(0) = omega * [-r_y(0), r_x(0), 0]
```

The vehicle is at rest on the rotating pad, hence its inertial velocity is that of
the pad. Total launch mass:

```
m(0) = stage1.dry_mass_kg + stage1.propellant_mass_kg
     + stage2.dry_mass_kg + stage2.propellant_mass_kg
```

`stage2.dry_mass_kg` includes the payload. The plan's timeline starts at this
instant.

## 4. Guidance geometry: azimuth, pitch plane, pitch program

**Local basis at the site at t = 0** (unit vectors):

```
rhat0 = r(0)/|r(0)|
Nhat   = [-sin(phi) cos(lam), -sin(phi) sin(lam), cos(phi)]      (local north)
Ehat   = [-sin(lam), cos(lam), 0]                                 (local east)
```

**Launch azimuth** `A = plan.launch_azimuth_deg` (degrees, in `[0, 360)`, measured
from north, positive toward east). It defines the **launch-direction unit vector**

```
uL = cos(A) * Nhat + sin(A) * Ehat          (unit vector, perpendicular to rhat0)
```

`uL` is computed once from the site geometry at `t = 0` and is then **fixed in the
inertial frame** for the whole flight.

**Pitch.** At any time `t` when an engine is firing, with `rhat = r(t)/|r(t)|` the
current local vertical, define the local horizontal reference direction as the
component of the fixed `uL` perpendicular to `rhat`:

```
hhat(t) = normalize( uL - (uL . rhat) rhat )
```

The pitch program gives `theta(t)` = pitch angle in degrees (the angle of the thrust
direction above the local horizon; negative pitch points thrust below the horizon).
The thrust unit direction is

```
that(t) = cos(theta(t)) * hhat(t) + sin(theta(t)) * rhat(t)
```

During coasts no engine fires and `theta` is irrelevant. This definition is well
conditioned because `|rhat . uL| < 1` throughout any feasible ascent.

**Pitch program format.** `plan.pitch_program` = `{"times_s": [t_0, ..., t_k],
"pitch_deg": [p_0, ..., p_k]}` with `t_0 = 0`, strictly increasing times, equal
length arrays. `theta(t)` is the **piecewise-linear** interpolant of the knots
`((t_i, p_i))`; for `t > t_k` it holds the last value `p_k`. (Before `t_0` never
occurs since `t_0 = 0`.)

## 5. Mass, thrust, staging, and the upper-stage schedule

Mass flow rate while a stage burns at full thrust `T` and specific impulse `Isp`:

```
mdot = T / (Isp * g0)          [kg/s]
```

Thrust magnitudes and specific impulses are constant (no throttle, no altitude
compensation). Staging is a strictly timed sequence:

1. **Stage-1 burn**: from `t = 0` the first stage burns at full thrust
   `stage1.thrust_N` along `that(t)` until its propellant is exhausted at
   ```
   t_burn1 = stage1.propellant_mass_kg / mdot1
   ```
   During the burn the total mass is `m(t) = m(0) - mdot1 * t`.
2. **Separation coast**: from `t_burn1` to `t_burn1 + separation_delay_s` both
   stages remain mated, all engines off (drag and gravity act; mass constant).
3. **Separation**: at `t = t_burn1 + separation_delay_s` the first stage (dry mass
   `stage1.dry_mass_kg`) is jettisoned instantaneously (no impulse delta).
4. **Upper-stage schedule**: starting at `t_2 = t_burn1 + separation_delay_s`, the
   plan's `upper_stage_schedule` executes in order. Each entry is
   `{"type": "burn"|"coast", "duration_s": d}` with `d > 0`:
   - `burn`: stage 2 fires at full thrust `stage2.thrust_N` along `that(t)`,
     losing mass at rate `mdot2`, **until either the entry's duration elapses or
     the stage-2 propellant is exhausted, whichever comes first**. On propellant
     exhaustion the entry continues engine-off (thrust zero, mass constant) for
     the remainder of its duration. Later `burn` entries with no propellant left
     are coasts.
   - `coast`: engine off.
   The schedule is executed in full: segment `j` spans
   `[t_2 + sum(d_0..d_{j-1}), t_2 + sum(d_0..d_j)]`.
5. **End of plan**: at the end of the final schedule entry. All reported end-of-plan
   quantities (Section 8) use the state `(r, v)` at exactly that instant.

Mass bookkeeping is exact and affine in time within each burn; propellant masses are
never negative (burns stop at exhaustion by construction).

## 6. Atmosphere and drag

The atmosphere co-rotates with the Earth. The airspeed relative to the atmosphere is

```
v_air(t) = v(t) - W x r(t)
```

The air density depends only on altitude `alt = |r| - R_earth`:

- if `alt <= atmosphere.altitude_m[0]`: `rho = density_kg_m3[0]`;
- if `alt >= atmosphere.altitude_m[-1]`: `rho = 0`;
- otherwise `rho` is the **linear interpolation** of the table at `alt`.

Drag acceleration (applies at all times, powered or coasting):

```
a_drag = -(1/2) * rho * Cd * S * |v_air| * v_air / m(t)
```

with `Cd = vehicle.drag_coefficient`, `S = vehicle.reference_area_m2`, both constant
for the whole flight.

## 7. Dynamic pressure

```
q(t) = (1/2) * rho(alt(t)) * |v_air(t)|^2
```

The **peak dynamic pressure** `q_max` of a flight is the maximum of `q` sampled on
the uniform grid `t = 0, 0.1, 0.2, ..., t_end` (the full plan duration; sampling
error at this grid is below 0.05% for any feasible trajectory). A plan is valid only
if `q_max <= q_limit_pa` (the grader allows 2% above: `q_max <= 1.02 * q_limit_pa`).

## 8. End-of-plan orbit and success criteria

From the end-of-plan state `(r, v)` compute the osculating two-body elements:

```
eps   = |v|^2/2 - mu/|r|                        (specific energy)
a     = -mu / (2 eps)                            (semi-major axis)
hvec  = r x v ;  h = |hvec|
e     = sqrt(1 + 2 eps h^2 / mu^2)               (eccentricity)
inc   = acos( hvec_z / h )                       (inclination, degrees in [0, 180])
apoapsis_altitude   = a (1 + e) - R_earth
periapsis_altitude  = a (1 - e) - R_earth
```

A plan **succeeds** on a problem instance iff all of the following hold when the
plan is flown through this specification:

1. `|apoapsis_altitude - target.altitude_m|  <= 30 000 m`
2. `|periapsis_altitude - target.altitude_m| <= 30 000 m`
3. `|inc - target.inclination_deg| <= 0.25 deg`
4. `q_max <= 1.02 * q_limit_pa` (with `q_max` from Section 7)
5. remaining propellant in every stage `>= 0` (guaranteed by the depletion rule;
   this condition certifies the plan never commands more than the vehicle has)
6. the end-of-plan orbit is closed: `e < 1` (and, implicitly, `eps < 0`)

Grading runs each plan through an independent implementation of Sections 1-8;
self-reported states are never used.

## 9. Plan schema (summary)

`plan_schema.json` is normative. In addition to the JSON schema, these semantic
rules apply (the grader enforces them):

- `launch_azimuth_deg` in `[0, 360)`.
- `pitch_program.times_s`: strictly increasing, `times_s[0] == 0.0`, at most 24
  knots, last knot `<= 1800 s`.
- `pitch_program.pitch_deg`: entries in `[-20, 90]`, same length as `times_s`.
- `upper_stage_schedule`: 1 to 12 entries, each `duration_s > 0`, total duration
  `<= 3000 s`.
- All numbers finite JSON floats (no NaN/Infinity).

## 10. Worked numerical check (conventions pinned)

To let you verify your propagator against this specification, here is one fixed
(problem, plan) pair and the exact trajectory quantities a conforming propagator
produces. The problem is `examples/problem_example.json`. The plan is:

```json
{
  "launch_azimuth_deg": 95.0,
  "pitch_program": {"times_s": [0.0, 15.0, 60.0], "pitch_deg": [90.0, 68.0, 30.0]},
  "upper_stage_schedule": [
    {"type": "burn", "duration_s": 200.0},
    {"type": "coast", "duration_s": 30.0},
    {"type": "burn", "duration_s": 250.0}
  ]
}
```

(This plan is *not* a good orbit insertion; it is only a numerical reference.)
With integrator tolerances at rtol 1e-9 or tighter, a conforming propagator finds
the values below (units m, m/s; agreement to ~6 significant digits is expected
from any accurate integrator):

```
CHECK-A  t = 15.0 s (during stage-1 burn):
         r = [ 6284341.900813, -1038209.144601,   148355.565866 ] m
         v = [     114.086506,      487.449316,       -2.312627 ] m/s
CHECK-B  end of plan (t = 672.324554 s):
         apoapsis_altitude   =  497789.208507 m
         periapsis_altitude  = -2413073.488169 m
         inclination         =       4.881509 deg
         eccentricity        =  0.268859253
         q_max               =  211952.901608 Pa
         stage2 propellant remaining = 0.000000 kg (exhausted during the final
         burn entry; the remainder of that entry and any later entries coast)
```

---

## 11. Practical notes (informative, not normative)

- Ignoring Earth rotation (`v(0) = 0`, `v_air = v`) shifts the achieved inclination
  by 1-2 degrees and mis-estimates dynamic pressure by tens of percent; it cannot
  meet the 0.25-degree inclination band.
- The launch azimuth that achieves a given inclination is *not* exactly the
  spherical-trig value `cos i = cos(phi) sin A` because the pad's inertial velocity
  `W x r(0)` is eastward and out of the pitch plane; a converged correction is
  required.
- Inclination is controlled almost purely by azimuth; apoapsis/periapsis are
  controlled by the pitch program shape and the upper-stage burn/coast timing.
- Propellant budgets in this problem family are sized so that a well-flown ascent
  consumes roughly 96-99% of the available ideal delta-v; plans that waste energy
  (steering loss, drag, deep-atmosphere loiter) cannot reach the target orbit.
