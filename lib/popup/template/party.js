core.main.party = {
  type: 'folder',
  label: 'watchParty',
  icon: new SvgRenderer('svg')
    .setAttribute('viewBox', '0 0 24 24')
    .appendChildren(
      new SvgRenderer('path').setAttribute(
        'd',
        'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m7.5-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6M9 13c-3.3 0-7 1.6-7 4v3h14v-3c0-2.4-3.7-4-7-4m7.5-1c-.5 0-1 0-1.6.1 1.3.9 2.1 2.2 2.1 3.9v3h5v-2.5c0-2.4-2.7-4.5-5.5-4.5',
      ),
    ),

  content: {
    type: 'main',
    label: 'watchParty',

    content: {
      party: {
        type: 'party',
      },
    },
  },
};
