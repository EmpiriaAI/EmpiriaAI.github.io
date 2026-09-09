window.EMPIRIA_ENVIRONMENTS = [
  {
    id: "rocket-ascent-guidance-clean",
    title: "Rocket Ascent Guidance",
    shortTitle: "Rocket Ascent Guidance",
    subtitle: "Design autonomous two-stage launch guidance for randomized orbital targets.",
    type: "terminal",
    typeLabel: "Terminal",
    family: "Terminal-Bench",
    category: "Scientific computing",
    status: "Available",
    difficulty: "Frontier",
    difficultyGrade: "Too hard or broken",
    expertEstimate: "6 hours",
    calibration: "Opus 0/5 · HY3 1/5",
    tags: [
      "Orbital mechanics",
      "Trajectory optimization",
      "Flight dynamics",
      "Numerical ODE integration",
      "Shooting method",
      "Aerospace"
    ],
    resources: [
      { label: "CPU", value: "2 cores" },
      { label: "Memory", value: "4 GB" },
      { label: "Storage", value: "10 GB" },
      { label: "GPU", value: "None" },
      { label: "Internet", value: "Allowed" },
      { label: "Runtime", value: "Python 3.11" }
    ],
    timeouts: [
      { label: "Environment build", value: "15 minutes" },
      { label: "Agent session", value: "2 hours" },
      { label: "Verifier", value: "1 hour 30 minutes" },
      { label: "Each solve() call", value: "900 seconds" }
    ],
    contract: {
      entrypoint: "solve(problem: dict) → plan: dict",
      artifact: "/app/solver.py",
      dependencies: "Python standard library · NumPy · SciPy",
      evaluation: "Independent physical re-simulation on 5 hidden instances",
      threshold: "At least 4 of 5 instances must pass every condition"
    },
    verification: [
      { label: "Apoapsis", value: "Target ±30 km" },
      { label: "Periapsis", value: "Target ±30 km" },
      { label: "Inclination", value: "Target ±0.25°" },
      { label: "Dynamic pressure", value: "≤ 1.02 × q limit" },
      { label: "Propellant", value: "Never negative" },
      { label: "Final orbit", value: "Closed · eccentricity < 1" }
    ],
    phases: [
      { code: "01", title: "Observe", detail: "Read the vehicle, site, atmosphere, q-limit, and target orbit." },
      { code: "02", title: "Model", detail: "Implement rotating-Earth dynamics, staging, drag, and orbital elements." },
      { code: "03", title: "Search", detail: "Optimize azimuth, pitch knots, burns, and coast durations." },
      { code: "04", title: "Verify", detail: "Return a valid plan for independent re-simulation on hidden cases." }
    ],
    files: [
      { path: "instruction.md", label: "Agent instruction", type: "markdown", size: "2.2 KB", public: true },
      { path: "task.toml", label: "Task configuration", type: "toml", size: "4.1 KB", public: true },
      { path: "README.md", label: "Dynamics specification", type: "markdown", size: "16.9 KB", public: true },
      { path: "plan_schema.json", label: "Output schema", type: "json", size: "2.7 KB", public: true },
      { path: "examples/problem_example.json", label: "Example problem", type: "json", size: "1.7 KB", public: true },
      { path: "Dockerfile", label: "Runtime image", type: "dockerfile", size: "0.4 KB", public: true }
    ],
    dataRoot: "data/environments/rocket-ascent-guidance-clean/"
  }
];
