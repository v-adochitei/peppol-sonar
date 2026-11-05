// Le fichier est lu ici et versé dans la zone de texte : le serveur ne reçoit qu'un champ de formulaire.
(function () {
  const depot = document.getElementById('depot');
  const champ = depot && depot.querySelector('textarea');
  const choix = document.getElementById('fichier');
  if (!depot || !champ) return;

  const verse = (file) => {
    if (!file) return;
    const lecteur = new FileReader();
    lecteur.onload = () => {
      champ.value = String(lecteur.result || '').replace(/^﻿/, '');
      depot.classList.remove('survol');
      const n = champ.value.split(/\r?\n/).filter((l) => l.trim()).length;
      const aide = document.getElementById('depot-aide');
      if (aide) aide.textContent = `${file.name} : ${n} ligne${n > 1 ? 's' : ''} chargée${n > 1 ? 's' : ''}. Lire la liste pour voir ce qui a été reconnu.`;
    };
    lecteur.readAsText(file);
  };

  for (const type of ['dragenter', 'dragover']) {
    depot.addEventListener(type, (e) => { e.preventDefault(); depot.classList.add('survol'); });
  }
  for (const type of ['dragleave', 'dragend']) {
    depot.addEventListener(type, () => depot.classList.remove('survol'));
  }
  depot.addEventListener('drop', (e) => {
    e.preventDefault();
    verse(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  if (choix) choix.addEventListener('change', () => verse(choix.files && choix.files[0]));
})();
