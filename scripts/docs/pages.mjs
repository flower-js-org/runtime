// The site's single table of contents. Every page's header, sidebar, pager,
// title and intro come from here; page files own only their content.
export const groups = [
  { id: "guide", label: "Guide", href: "guide/", note: "Small API.<br>Ordinary TypeScript.<br>Durable decisions." },
  { id: "operate", label: "Operate", href: "operate/", note: "Three nodes.<br>One failure tolerated.<br>Honest limits." },
  { id: "reference", label: "Reference", href: "reference/", note: "Clear contracts.<br>Honest limits.<br>Room to grow." },
];

export const pages = [
  {
    path: "guide/index.html", group: "guide", label: "Get started",
    title: "Run Flower in five minutes.",
    lead: "Build the server, start one node, deploy an app and call it.",
    description: "Build Flower, start a local node, deploy a TypeScript application, and call its methods.",
  },
  {
    path: "guide/applications.html", group: "guide", label: "Applications",
    title: "Your code is the API.",
    lead: "An app is collections of JSON records, values derived from them, and methods that read or change them. Only the methods you list are public.",
    description: "Define collections, derived values, queries and mutations, and choose which methods are public.",
  },
  {
    path: "guide/reactivity.html", group: "guide", label: "Reactive values",
    title: "Derived values stay up to date.",
    lead: "Flower remembers what each derived value reads. When those records change, it recomputes the value in the same commit.",
    description: "How Flower tracks dependencies, keeps materialized values current, and maintains aggregates from row deltas.",
  },
  {
    path: "guide/methods.html", group: "guide", label: "Methods & retries",
    title: "Call methods safely.",
    lead: "Call queries and mutations from TypeScript, the CLI or plain HTTP. A request ID makes retries safe.",
    description: "Call Flower methods over HTTP or the SDK, authorize callers, retry safely, and span several groups in one transaction.",
  },
  {
    path: "guide/reads.html", group: "guide", label: "Reads & live queries",
    title: "Read from any replica.",
    lead: "Spread queries across replicas, choose between fresh and fast reads, and watch values change live.",
    description: "Distribute fresh reads across replicas, opt into replica-local reads, use HTTP/2, and watch live queries.",
  },
  {
    path: "guide/timers.html", group: "guide", label: "Scheduled logic",
    title: "Run code later.",
    lead: "Schedule a mutation to run after a deadline. The schedule is saved in the same commit as the change that made it.",
    description: "Schedule durable callbacks that run application mutations after a deadline.",
  },
  {
    path: "guide/leases.html", group: "guide", label: "Leases & expiry",
    title: "Hand out work. Let records expire.",
    lead: "Give a job to one worker at a time, and treat old records as gone. Both are plain TypeScript helpers.",
    description: "Lease work to external workers, fence results, and expire records with ordinary TypeScript.",
  },
  {
    path: "guide/workers.html", group: "guide", label: "External workers",
    title: "Do slow work outside the database.",
    lead: "Workers are ordinary processes. They watch for work, do it, and report back through a mutation.",
    description: "Design reactive external workers: keep a result current, or complete every queued action exactly once.",
  },
  {
    path: "guide/worker-pools.html", group: "guide", label: "Worker pools",
    title: "Run a pool of workers.",
    lead: "A complete, tested job worker. Start as many copies as you like: they share one queue, and when one dies, another finishes its jobs.",
    description: "A complete, tested Flower job worker: run many copies, survive crashes and outages, and know when to add more.",
  },
  {
    path: "guide/crypto.html", group: "guide", label: "Crypto & tokens",
    title: "Sign and encrypt without seeing the keys.",
    lead: "Use NaCl and JWT inside your methods. Private keys stay in the server; your code only gets handles.",
    description: "Use NaCl and JWT inside Flower callbacks, with managed keys that never enter application memory.",
  },
  {
    path: "guide/deployments.html", group: "guide", label: "Deploy changes",
    title: "Ship new code.",
    lead: "Deploying new code recomputes derived values. Large apps can prepare the new version in the background, then switch over. Stored records change only when your own code migrates them.",
    description: "Deploy computation changes, stage large rebuilds, tune page sizes, and migrate stored records.",
  },
  {
    path: "operate/index.html", group: "operate", label: "Run a cluster",
    title: "Run a three-node cluster.",
    lead: "Three nodes survive one failure. The leader runs writes, a majority confirms them, and any node can answer reads.",
    description: "Start and operate a three-node Flower cluster: acknowledgements, operator routines and partition resizing.",
  },
  {
    path: "operate/capacity.html", group: "operate", label: "Capacity & budgets",
    title: "Size it for your machine.",
    lead: "The settings that control how much work each node accepts, and how long each call may run.",
    description: "Configure Flower's capacity, execution and transport budgets for your machine.",
  },
  {
    path: "operate/benchmarks.html", group: "operate", label: "Benchmarks",
    title: "How fast is it?",
    lead: "The latest measured run, what it measures, and how to run it yourself.",
    description: "The latest measured Flower benchmark, its workload, and how to reproduce and profile it.",
  },
  {
    path: "operate/boundaries.html", group: "operate", label: "Current boundaries",
    title: "What works today, and what doesn’t yet.",
    lead: "Flower is a working prototype. Here is what it does, and the limits to plan around.",
    description: "What Flower implements today, and the limits to plan around.",
  },
  {
    path: "reference/index.html", group: "reference", label: "Packages",
    catalogue: "All reference pages",
    title: "SDK reference.",
    lead: "Every public API, with its defaults and failure behavior. Flower is unreleased: APIs and storage formats may still change.",
    description: "Flower SDK reference: packages and entry points, with an index of every reference page.",
  },
  {
    path: "reference/data.html", group: "reference", label: "Values & collections",
    title: "Values and collections.",
    lead: "What a value can be, how collections and indexes work, and incremental totals.",
    description: "Reference for Flower values, collections, indexes, ordered scans and incremental aggregates.",
  },
  {
    path: "reference/definitions.html", group: "reference", label: "Contexts & definitions",
    title: "Contexts and definitions.",
    lead: "What a method can do with <code>ctx</code>, and how <code>define</code> builds the public method list.",
    description: "Reference for callback contexts, definitions and the public method table.",
  },
  {
    path: "reference/client.html", group: "reference", label: "Client & transports",
    title: "Client and transports.",
    lead: "<code>FlowerClient</code>, live watches, and the HTTP/2 transport.",
    description: "Reference for FlowerClient, SSE watches and the HTTP/2 transport.",
  },
  {
    path: "reference/time.html", group: "reference", label: "Expiry, leases & timers",
    title: "Expiry, leases and timers.",
    lead: "Records that expire, jobs leased to one worker, and callbacks that run later.",
    description: "Reference for expiring records, worker leases and delayed callbacks.",
  },
  {
    path: "reference/crypto.html", group: "reference", label: "NaCl & JWT",
    title: "NaCl and JWT.",
    lead: "Signing, encryption and tokens inside your methods.",
    description: "Reference for Flower's native NaCl and JWT APIs.",
  },
  {
    path: "reference/keys.html", group: "reference", label: "Managed keys",
    title: "Managed keys.",
    lead: "Declare a key in code; an operator provides it. Private key bytes never reach your code.",
    description: "Reference for managed keys: handles, provisioning, rotation, authorization and limits.",
  },
  {
    path: "reference/partitions.html", group: "reference", label: "Partitions & transactions",
    title: "Partitions and transactions.",
    lead: "Move tenants between Raft groups, and commit changes across groups at once.",
    description: "Reference for logical partitions, resizing and cross-group transactions.",
  },
  {
    path: "reference/deployments.html", group: "reference", label: "Staged deployment",
    title: "Staged deployment.",
    lead: "Prepare a new version in the background, switch to it, then clean up.",
    description: "Reference for staged deployment phases, tuning and data migrations.",
  },
  {
    path: "reference/cli.html", group: "reference", label: "Bundles & CLI",
    title: "Bundles and CLI.",
    lead: "Build app bundles, and deploy, call and watch from the terminal.",
    description: "Reference for Flower bundle tools and the command-line interface.",
  },
  {
    path: "reference/access.html", group: "reference", label: "Authorization & retention",
    title: "Authorization and retention.",
    lead: "Check every caller, and limit how long retry results are kept.",
    description: "Reference for application authorization and retry-history retention.",
  },
  {
    path: "reference/limits.html", group: "reference", label: "Operational limits",
    title: "Operational limits.",
    lead: "The limits and failure modes your code should plan for.",
    description: "Reference for Flower's operational limits and tradeoffs.",
  },
];

// Former single-page URLs. Their fragments map to the new pages in redirects.json.
export const legacy = [
  { path: "guide.html", title: "Field guide", target: "guide/" },
  { path: "api.html", title: "SDK reference", target: "reference/" },
  { path: "workers.html", title: "External workers", target: "guide/workers.html" },
];
