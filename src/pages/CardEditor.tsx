import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Skeletons, Toggle, useToast } from '../components/ui';
import {
  INTENTS,
  INTENT_LABEL,
  SECTOR_OPTIONS,
  type BusinessCardInput,
  type Entity,
  type Intent,
} from '../../shared/types';

export default function CardEditor() {
  const { user, refresh, loading: sessionLoading } = useSession();
  const navigate = useNavigate();
  const t = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [countries, setCountries] = useState<Entity[]>([]);

  const [displayName, setDisplayName] = useState('');
  const [company, setCompany] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [country, setCountry] = useState('GHA');
  const [city, setCity] = useState('');
  const [website, setWebsite] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [intents, setIntents] = useState<Intent[]>([]);
  const [sectors, setSectors] = useState<string[]>([]);
  const [hsCodes, setHsCodes] = useState('');
  const [markets, setMarkets] = useState<string[]>([]);
  const [published, setPublished] = useState(true);

  useEffect(() => {
    if (!sessionLoading && !user) navigate('/join?next=/me/card', { replace: true });
  }, [sessionLoading, user, navigate]);

  useEffect(() => {
    Promise.all([
      api.network.myCard().catch(() => ({ card: null })),
      api.entities({ kind: 'country', all: '1' }).catch(() => ({ entities: [] as Entity[] })),
    ])
      .then(([c, e]) => {
        setCountries(e.entities);
        const card = c.card;
        if (card) {
          setDisplayName(card.display_name);
          setCompany(card.company ?? '');
          setHeadline(card.headline ?? '');
          setBio(card.bio ?? '');
          setCountry(card.country_iso3);
          setCity(card.city ?? '');
          setWebsite(card.website ?? '');
          setWhatsapp(card.whatsapp ?? '');
          setIntents(card.intents);
          setSectors(card.sectors);
          setHsCodes(card.hs_codes.join(', '));
          setMarkets(card.target_markets);
          setPublished(card.is_published === 1);
        } else if (user) {
          setDisplayName(user.full_name);
          if (user.country_iso3) setCountry(user.country_iso3);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  function toggleIn<T>(list: T[], value: T, setter: (v: T[]) => void, cap = 99) {
    setter(
      list.includes(value) ? list.filter((x) => x !== value) : [...list, value].slice(0, cap),
    );
  }

  async function save() {
    if (!displayName.trim()) return t.err('Add a display name');
    if (intents.length === 0) return t.err('Pick at least one thing you are here to do');

    const payload: BusinessCardInput = {
      display_name: displayName.trim(),
      company: company.trim() || null,
      headline: headline.trim() || null,
      bio: bio.trim() || null,
      country_iso3: country,
      city: city.trim() || null,
      website: website.trim() || null,
      whatsapp: whatsapp.trim() || null,
      intents,
      sectors,
      hs_codes: hsCodes
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      target_markets: markets,
      is_published: published,
    };

    setSaving(true);
    try {
      await api.network.saveCard(payload);
      await refresh();
      t.ok('Card saved');
      setTimeout(() => navigate('/network'), 500);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || sessionLoading) return <Skeletons n={5} />;

  return (
    <>
      {t.node}

      <p className="small dim" style={{ marginTop: 0 }}>
        This is what other people see. Keep it short — what you trade, and whether you are buying or
        selling.
      </p>

      <div className="card">
        <p className="card-title">You</p>

        <div className="field">
          <label htmlFor="dn">Display name</label>
          <input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="co">Company (optional)</label>
          <input
            id="co"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Boateng Agro Ltd"
          />
        </div>

        <div className="field">
          <label htmlFor="hl">One line about you</label>
          <input
            id="hl"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Moringa grower, Northern Ghana"
            maxLength={90}
          />
          <div className="help">This is the line people read first in search results.</div>
        </div>

        <div className="grid two-md">
          <div className="field">
            <label htmlFor="cn">Country</label>
            <select id="cn" value={country} onChange={(e) => setCountry(e.target.value)}>
              {countries.map((c) => (
                <option key={c.slug} value={c.iso3 ?? ''}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ci">City (optional)</label>
            <input id="ci" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Tamale" />
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">What are you here to do?</p>
        <div className="row wrap" style={{ gap: 7 }}>
          {INTENTS.map((i) => (
            <button
              key={i}
              type="button"
              className={`chip ${intents.includes(i) ? 'active' : ''}`}
              onClick={() => toggleIn(intents, i, setIntents)}
            >
              {INTENT_LABEL[i]}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Sectors you work in</p>
        <div className="row wrap" style={{ gap: 7 }}>
          {SECTOR_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${sectors.includes(s) ? 'active' : ''}`}
              onClick={() => toggleIn(sectors, s, setSectors, 8)}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
          <label htmlFor="hs">Products (optional)</label>
          <input
            id="hs"
            value={hsCodes}
            onChange={(e) => setHsCodes(e.target.value)}
            placeholder="moringa, shea butter, 18 (cocoa)"
          />
          <div className="help">
            Free text or HS chapter numbers. People search on these, so use the words a buyer would.
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Markets you want to reach</p>
        <div className="row wrap" style={{ gap: 7 }}>
          {countries.slice(0, 40).map((c) => (
            <button
              key={c.slug}
              type="button"
              className={`chip ${markets.includes(c.iso3 ?? '') ? 'active' : ''}`}
              onClick={() => toggleIn(markets, c.iso3 ?? '', setMarkets, 12)}
            >
              {c.iso3}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <p className="card-title">How to reach you</p>
        <div className="grid two-md">
          <div className="field">
            <label htmlFor="ws">Website (optional)</label>
            <input
              id="ws"
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="field">
            <label htmlFor="wa">WhatsApp (optional)</label>
            <input
              id="wa"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="+233…"
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="bio">More detail (optional)</label>
          <textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Volumes you handle, certifications, how you ship."
          />
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div style={{ fontWeight: 650 }}>Visible to others</div>
            <div className="tiny dim" style={{ maxWidth: 380 }}>
              Turn this off to keep your card private while you finish it.
            </div>
          </div>
          <Toggle checked={published} onChange={setPublished} />
        </div>
      </div>

      <button className="btn primary block" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save card'}
      </button>
    </>
  );
}
