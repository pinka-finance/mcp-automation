// Offline test validacije/mapiranja configa (ne treba bazu). npm run test:config
import { CreateCampaignInput } from "../src/tools/create-campaign.js";
import { configToRpcParams } from "../src/lib/campaign-config.js";

let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "✅" : "❌"} ${m}`);
  if (!c) fail++;
};

// 1) valjani config + mapiranje
const input = {
  title: "Podrži epizodu: Zadruge i budućnost bankarstva",
  type: "donation" as const,
  description: "test opis",
  goal_eur: 5000,
  min_contribution_eur: 2,
  visibility: "public" as const,
  subject_type: "podcast_episode",
  subject_ref: "b-nls1ck8EE",
  cover_image_url: "https://cdn.domovina.ai/images/b-nls1ck8EE/thumbnail.png",
  youtube_channel_id: "UCXXhnehl2pss0uYdfLRDtyw",
  activate: true,
};
const parsed = CreateCampaignInput.parse(input);
const rpc = configToRpcParams(parsed);
ok(rpc.p_goal_cents === 500000, `goal 5000 € → 500000 centi (dobio ${rpc.p_goal_cents})`);
ok(rpc.p_min_contribution_cents === 200, `min 2 € → 200 centi (dobio ${rpc.p_min_contribution_cents})`);
ok(rpc.p_subject_type === "podcast_episode", "subject_type prolazi");
ok(rpc.p_recurrence === "none", "recurrence default none");

// 2) defaulti kad polja fale
const min = configToRpcParams(CreateCampaignInput.parse({ title: "Dovoljno dug naslov" }));
ok(min.p_type === "donation", "type default donation");
ok(min.p_min_contribution_cents === 100, "min default 100 centi");
ok(min.p_goal_cents === null, "goal default null (open-ended)");
ok(min.p_visibility === "private", "visibility default private");

// 3) negativni testovi (moraju biti odbijeni)
const rejects: [string, unknown][] = [
  ["prekratak naslov", { title: "ab" }],
  ["goal ispod 1 €", { title: "Dovoljno dug naslov", goal_eur: 0.5 }],
  ["nepoznato polje (strict)", { title: "Dovoljno dug naslov", foo: "bar" }],
  ["min iznad goal", { title: "Dovoljno dug naslov", goal_eur: 1, min_contribution_eur: 5 }],
  ["ends_at u prošlosti", { title: "Dovoljno dug naslov", ends_at: "2020-01-01" }],
  ["loš subject_type", { title: "Dovoljno dug naslov", subject_type: "Bad Type!" }],
];
for (const [name, bad] of rejects) {
  const r = CreateCampaignInput.safeParse(bad);
  let rejected = !r.success;
  if (r.success) {
    try { configToRpcParams(r.data); } catch { rejected = true; }
  }
  ok(rejected, `odbija: ${name}`);
}

console.log(fail === 0 ? "\n✅ SVE OK" : `\n❌ ${fail} PADOVA`);
process.exit(fail === 0 ? 0 : 1);
