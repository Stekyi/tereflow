/**
 * Plain-language help, kept in one place so the floating page button and the small info icons
 * say the same thing. Each entry answers four questions a reader has: what is this, how does it
 * help me find or check a trade, how do I read it, and what do I do next.
 */
export interface HelpEntry {
  title: string;
  what: string;
  helps: string;
  read?: string;
  next: string;
}

export const PAGE_HELP: { match: RegExp; help: HelpEntry }[] = [
  {
    match: /^\/$/,
    help: {
      title: 'Products',
      what: 'The list of traded products, ranked by how fast each one is moving in world trade. It is built from UN Comtrade and national customs data.',
      helps: 'It points you at products where demand is growing before everyone else has noticed, so you can pick something worth looking into instead of guessing.',
      read: 'A higher momentum score means faster recent growth, not an easier market to enter. Use the filters to narrow by country, exports or imports, and size.',
      next: 'Tap a product to see who sells it and who buys it. If it looks right, open the feasibility view or the Guide to test whether you can supply it.',
    },
  },
  {
    match: /^\/countries$/,
    help: {
      title: 'Countries',
      what: 'Every country we hold trade data for, with its total trade and top lines.',
      helps: 'It shows you which markets are buying and selling the most, so you can choose a country to sell into or source from.',
      next: 'Open a country to see what it buys, what it sells, its trade balance and its early signals.',
    },
  },
  {
    match: /^\/country\//,
    help: {
      title: 'Country page',
      what: 'One country in depth: what it imports and exports, who it trades with, its trade balance and the market behind the numbers.',
      helps: 'It tells you whether this country is a good place to sell to or buy from, and which products have real demand there.',
      read: 'Use the section chips under the header to jump around. "Early signals" are products gaining momentum. "Blue oceans" are products with demand but few suppliers.',
      next: 'Pick a product that looks promising and open it for the full picture, or save the country to your feed.',
    },
  },
  {
    match: /^\/feasibility\//,
    help: {
      title: 'Feasibility',
      what: 'A quick check of whether a particular product can work for a particular country.',
      helps: 'It turns the raw numbers into a yes, maybe or not yet, so you stop short of a bad bet early.',
      next: 'If it looks workable, open the Guide to map the supply chain and the problems you would need to solve.',
    },
  },
  {
    match: /^\/guide\/runs/,
    help: {
      title: 'Saved guide runs',
      what: 'The guides you saved earlier, kept so you can come back to them.',
      helps: 'It lets you compare two products or two countries side by side, so you can decide between them.',
      next: 'Open a run to read it again, or tick two and compare them.',
    },
  },
  {
    match: /^\/guide$/,
    help: {
      title: 'Problem to supply',
      what: 'A guide that takes a product and a market and walks the whole chain: who makes it, who moves it, where it strains, and what problems stand in the way.',
      helps: 'It shows you where the gaps are, so you can see what you would actually have to solve to supply this product.',
      read: 'Work down the four steps. Each step has links to the underlying data, so you can check every claim.',
      next: 'Save the run, compare it with another, or print it as a one-page PDF to share.',
    },
  },
  {
    match: /^\/opportunities/,
    help: {
      title: 'Opportunities',
      what: 'Products with the momentum to reshape a market, found before they reach the headline rankings.',
      helps: 'It gives you the early read, when entry is cheapest, instead of the crowded products everyone already knows.',
      read: 'Rankings show speed of growth. They do not tell you how hard a market is to enter, so check feasibility before acting.',
      next: 'Open a signal, read why it scored the way it did, then test it in the sandbox or the Guide.',
    },
  },
  {
    match: /^\/sandbox/,
    help: {
      title: 'Trade sandbox',
      what: 'A workbench where you try a product against a country with your own assumptions.',
      helps: 'It lets you test a trade idea on paper first, with costs and volumes, before you spend money on it.',
      read: 'Change one assumption at a time and watch how the result moves. The result is only as good as what you put in.',
      next: 'If the numbers hold, save the run and look at the supply chain in the Guide.',
    },
  },
  {
    match: /^\/news/,
    help: {
      title: 'Trade news',
      what: 'Recent news that affects trade: tariffs, shipping, harvests, policy.',
      helps: 'It helps you spot events that will move a product before they show up in the figures.',
      next: 'If a story touches a product you follow, open that product and check whether the numbers agree.',
    },
  },
  {
    match: /^\/network/,
    help: {
      title: 'Network',
      what: 'A directory of traders, producers and service providers, each with a business card.',
      helps: 'It is how you find a supplier, a buyer or a partner for the trade you are looking at.',
      next: 'Open a card to read it and send a message. Make your own card from the Me tab so others can find you.',
    },
  },
  {
    match: /^\/messages/,
    help: {
      title: 'Messages',
      what: 'Your conversations with other people on Tereflow.',
      helps: 'It keeps a deal conversation in one place after you find someone in the Network.',
      next: 'Open a conversation to reply. Keep early talks here until you trust each other.',
    },
  },
  {
    match: /^\/market/,
    help: {
      title: 'Market',
      what: 'Listings from members: goods offered and goods wanted.',
      helps: 'It turns a trade idea into a real offer, so you can see who is actually buying and selling right now.',
      next: 'Open a listing to read the terms, or post your own from New listing.',
    },
  },
  {
    match: /^\/(activity|saved|notifications)/,
    help: {
      title: 'Your activity',
      what: 'What you saved, what you followed, and what has changed since you last looked.',
      helps: 'It saves you searching again for things you already found.',
      next: 'Open anything saved to carry on where you left off.',
    },
  },
  {
    match: /^\/me\/card/,
    help: {
      title: 'My business card',
      what: 'The public card other members see in the Network.',
      helps: 'A clear card is how buyers and suppliers find you and decide to contact you.',
      next: 'Fill in what you trade and where, then publish it so it shows up in search.',
    },
  },
  {
    match: /^\/me/,
    help: {
      title: 'Me',
      what: 'Your account, your card, your saved items and your membership.',
      helps: 'It is where you set up what you care about so the feed and signals fit you.',
      next: 'Finish setting up your profile, then check your feed.',
    },
  },
  {
    match: /^\/feed/,
    help: {
      title: 'Your feed',
      what: 'A weekly read on the products and markets you follow: who is selling, who is buying, and which way it is moving.',
      helps: 'It keeps watch for you, so you hear about a change without searching for it.',
      next: 'Follow more products or markets to make it sharper. Open an item for the detail behind it.',
    },
  },
  {
    match: /^\/playbooks/,
    help: {
      title: 'How to start',
      what: 'Entry playbooks for a sector and a market, drawn from the institutions that set the rules.',
      helps: 'It tells you the practical first steps: licences, standards, paperwork, who to talk to.',
      next: 'Open a playbook and follow it step by step.',
    },
  },
  {
    match: /^\/upgrade/,
    help: {
      title: 'Support Tereflow',
      what: 'Donate any amount to help the app grow. In return you get six months of premium.',
      helps: 'Premium unlocks early signals, the playbook library and your weekly feed. The trade data stays free.',
      next: 'Choose an amount and donate. When the six months end, donate again to keep premium.',
    },
  },
  {
    match: /^\/join/,
    help: {
      title: 'Join',
      what: 'Create a free account or sign in.',
      helps: 'An account lets you save work, follow products and message people.',
      next: 'Sign up, then finish your profile so the app can tailor what it shows you.',
    },
  },
  {
    match: /^\/registry/,
    help: {
      title: 'Data registry',
      what: 'The list of data sources behind the figures and how fresh each one is.',
      helps: 'It lets you check where a number came from before you rely on it.',
      next: 'Open a source to see its coverage and last update.',
    },
  },
];

export function helpForPath(path: string): HelpEntry | null {
  return PAGE_HELP.find((h) => h.match.test(path))?.help ?? null;
}

/** Small pieces of a page: tabs, charts and features. Keyed by a short id used in <InfoTip k="..." />. */
export const TIPS: Record<string, HelpEntry> = {
  'product-list': {
    title: 'Product ranking',
    what: 'Each row is a traded product with its momentum score and trade value.',
    helps: 'It shows you where trade is growing, so you can shortlist products worth a closer look.',
    read: 'The score is speed of growth out of 100. A high score with a small value can be an early opening; a high value with a low score is a big, slow market.',
    next: 'Tap a product to see sellers, buyers and the trend.',
  },
  'country-buys': {
    title: 'What it buys',
    what: 'The products this country imports the most, by value.',
    helps: 'These are the things the country already pays for, so they are your most likely buyers.',
    next: 'Pick a product you could supply and open it to see who sells it to them today.',
  },
  'country-sells': {
    title: 'What it sells',
    what: 'The products this country exports the most, by value.',
    helps: 'It shows what the country is good at making, which is a guide to sourcing from it.',
    next: 'Open a product to see who buys it and whether demand is growing.',
  },
  'trade-balance': {
    title: 'Trade balance',
    what: 'Exports minus imports for the country, year by year.',
    helps: 'It tells you whether the country earns more than it spends abroad, which affects how it pays for imports.',
    read: 'Below zero means it imports more than it exports. A growing gap can mean strong appetite for imports, or pressure on its currency.',
    next: 'Look at the lines driving the gap, then check the partners that supply them.',
  },
  'early-signals': {
    title: 'Early signals',
    what: 'Products whose trade is picking up speed but are not yet in the headline rankings.',
    helps: 'Entry is usually cheapest before everyone notices a product, so these are your earliest leads.',
    read: 'A signal shows growth, not ease of entry. Check feasibility before you commit.',
    next: 'Open a signal, then test it in the sandbox.',
  },
  'blue-oceans': {
    title: 'Blue oceans',
    what: 'Products where there is real demand but few suppliers competing for it.',
    helps: 'Less competition can mean an easier way in, so these are good places to look for a gap.',
    read: 'Few suppliers can also mean a hard product to make or ship. Read why before you chase it.',
    next: 'Open one and look at who supplies it now and what stops others entering.',
  },
  partners: {
    title: 'Trading partners',
    what: 'The countries this country trades with most, and the value of that trade.',
    helps: 'It shows you who you would compete with, and which routes already exist.',
    next: 'Open a partner to compare the two markets.',
  },
  'market-behind': {
    title: 'The market behind the trade',
    what: 'Population, income and spending figures for the country, mostly from the World Bank.',
    helps: 'It tells you how big and how wealthy the buying market is, beyond the customs numbers.',
    next: 'Use it to size a trade idea: more people with more to spend means more room to sell.',
  },
  'what-this-means': {
    title: 'What this means',
    what: 'A plain-language reading of the country numbers.',
    helps: 'It turns the figures into a few sentences you can act on.',
    next: 'Follow the links under each point to see the data behind it.',
  },
  'guide-chain': {
    title: 'The chain',
    what: 'The steps a product passes through, from producer to buyer, and who does each one.',
    helps: 'It shows you where in the chain you could fit.',
    next: 'Move to the next step to see where the chain is under strain.',
  },
  'guide-strain': {
    title: 'Where the trade strains',
    what: 'The points in the chain that are weak: shortages, high costs, delays or rules.',
    helps: 'Strain is where a new supplier can add value, so this is where an opening usually is.',
    next: 'Read the problems list that follows and pick one you could solve.',
  },
  'following': {
    title: 'Following',
    what: 'The products and markets you chose to watch.',
    helps: 'Your weekly feed is built from this list, so a better list means a better feed.',
    next: 'Add or remove items until the feed shows only what matters to you.',
  },
  'section-nav': {
    title: 'Page sections',
    what: 'Shortcuts to the parts of this long page.',
    helps: 'It saves scrolling when you want a particular part, like partners or early signals.',
    next: 'Tap a chip to jump to that part.',
  },
};
