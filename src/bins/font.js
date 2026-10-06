/* Drawerforge — https://drawerforge.co.uk
 *
 * The letters a bin's note is printed in, on its label shelf (src/bins/text.js reads them).
 *
 * The glyph data in this file is the Hershey Simplex fonts. It is not Drawerforge's work
 * and is not under Drawerforge's licence: it keeps the terms it came with, which ask for
 * two acknowledgements to travel with it, and those are these:
 *
 *   - The Hershey Fonts were originally created by Dr. A. V. Hershey while working at
 *     the U. S. National Bureau of Standards.
 *   - The format of the Font data in this distribution was originally created by
 *       James Hurt
 *       Cognition, Inc.
 *       900 Technology Park Drive
 *       Billerica, MA 01821
 *       (mit-eddie!ci-dandelion!hurt)
 *
 * The rest of those terms: this distribution of the Hershey Fonts may be used by anyone
 * for any purpose, commercial or otherwise, and its font data may be converted into any
 * other format except the one distributed by the U.S. NTIS. It is not converted at all
 * here. Each string is one glyph exactly as the distribution writes it, Hurt's format:
 * the first two characters are the glyph's left and right edges, then each pair of
 * characters is a point, x then y, each as its character code less 82 (R is 0), y
 * counting down, and " R" lifts the pen. The cap height runs from y -12 to the baseline
 * at 9.
 *
 * Taken from the hershey-fonts distribution packaged by Kamal Mostafa
 * (https://github.com/kamalmostafa/hershey-fonts): futural.jhf, Simplex Roman, for
 * printable ASCII, and from greeks.jhf, Simplex Greek, glyph 638 for µ, 550 for Ω and
 * 718, Hershey's own degree sign, for °. The three after those, ± × Ø, are not in either
 * file, so they are drawn here in the same format from strokes Simplex Roman already
 * uses; those three strings are Drawerforge's, under its licence (AGPL-3.0-or-later,
 * see LICENSE and NOTICE).
 *
 * Why Hershey Simplex: it is a single-stroke font, so a letter is a few lines rather than
 * an outline with holes in it — B, 8 and % as outlines need a hole in a face, and the
 * only way this engine fills one is the keyhole path that fails silently (ENGINE.md). The
 * strokes become closed convex shells instead (text.js). And its terms allow any use with
 * the acknowledgements above, which is an attribution term the AGPL allows.
 *
 * Nothing in this file is a less-than sign followed by a slash, the one thing that could
 * end the page's inline script early: every character of the glyph strings is a space
 * or one from B to b in ASCII, and neither sign is in that range. test/bin-audit.js
 * checks both.
 */
'use strict';

const HERSHEY_SIMPLEX = {
  /* ASCII 32 (space) to 126 (~), in order, from futural.jhf. */
  ascii: [
    "JZ", "MWRFRT RRYQZR[SZRY", "JZNFNM RVFVM", "H]SBLb RYBRb RLOZO RKUYU",
    "H\\PBP_ RTBT_ RYIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    "F^[FI[ RNFPHPJOLMMKMIKIIJGLFNFPGSHVHYG[F RWTUUTWTYV[X[ZZ[X[VYTWT",
    "E_\\O\\N[MZMYNXPVUTXRZP[L[JZIYHWHUISJRQNRMSKSIRGPFNGMIMKNNPQUXWZY[[[\\Z\\Y",
    "MWRHQGRFSGSIRKQL", "KYVBTDRGPKOPOTPYR]T`Vb", "KYNBPDRGTKUPUTTYR]P`Nb",
    "JZRLRX RMOWU RWOMU", "E_RIR[ RIR[R", "NVSWRXQWRVSWSYQ[", "E_IR[R", "NVRVQWRXSWRV",
    "G][BIb", "H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF", "H\\NJPISFS[",
    "H\\LKLJMHNGPFTFVGWHXJXLWNUQK[Y[", "H\\MFXFRNUNWOXPYSYUXXVZS[P[MZLYKW",
    "H\\UFKTZT RUFU[", "H\\WFMFLOMNPMSMVNXPYSYUXXVZS[P[MZLYKW",
    "H\\XIWGTFRFOGMJLOLTMXOZR[S[VZXXYUYTXQVOSNRNOOMQLT", "H\\YFO[ RKFYF",
    "H\\PFMGLILKMMONSOVPXRYTYWXYWZT[P[MZLYKWKTLRNPQOUNWMXKXIWGTFPF",
    "H\\XMWPURRSQSNRLPKMKLLINGQFRFUGWIXMXRWWUZR[P[MZLX", "NVROQPRQSPRO RRVQWRXSWRV",
    "NVROQPRQSPRO RSWRXQWRVSWSYQ[", "F^ZIJRZ[", "E_IO[O RIU[U", "F^JIZRJ[",
    "I[LKLJMHNGPFTFVGWHXJXLWNVORQRT RRYQZR[SZRY",
    "E`WNVLTKQKOLNMMPMSNUPVSVUUVS RQKOMNPNSOUPV RWKVSVUXVZV\\T]Q]O\\L[JYHWGTFQFNGLHJJILHOHRIUJWLYNZQ[T[WZYYZX RXKWSWUXV",
    "I[RFJ[ RRFZ[ RMTWT", "G\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[",
    "H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV", "G\\KFK[ RKFRFUGWIXKYNYSXVWXUZR[K[",
    "H[LFL[ RLFYF RLPTP RL[Y[", "HZLFL[ RLFYF RLPTP",
    "H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZS RUSZS", "G]KFK[ RYFY[ RKPYP", "NVRFR[",
    "JZVFVVUYTZR[P[NZMYLVLT", "G\\KFK[ RYFKT RPOY[", "HYLFL[ RL[X[",
    "F^JFJ[ RJFR[ RZFR[ RZFZ[", "G]KFK[ RKFY[ RYFY[",
    "G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF", "G\\KFK[ RKFTFWGXHYJYMXOWPTQKQ",
    "G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RSWY]",
    "G\\KFK[ RKFTFWGXHYJYLXNWOTPKP RRPY[", "H\\YIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    "JZRFR[ RKFYF", "G]KFKULXNZQ[S[VZXXYUYF", "I[JFR[ RZFR[", "F^HFM[ RRFM[ RRFW[ R\\FW[",
    "H\\KFY[ RYFK[", "I[JFRPR[ RZFRP", "H\\YFK[ RKFYF RK[Y[", "KYOBOb RPBPb ROBVB RObVb",
    "KYKFY^", "KYTBTb RUBUb RNBUB RNbUb", "JZRDJR RRDZR", "I[Ib[b", "NVSKQMQORPSORNQO",
    "I\\XMX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", "H[LFL[ RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    "I[XPVNTMQMONMPLSLUMXOZQ[T[VZXX", "I\\XFX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "I[LSXSXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX", "MYWFUFSGRJR[ ROMVM",
    "I\\XMX]W`VaTbQbOa RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", "I\\MFM[ RMQPNRMUMWNXQX[",
    "NVQFRGSFREQF RRMR[", "MWRFSGTFSERF RSMS^RaPbNb", "IZMFM[ RWMMW RQSX[", "NVRFR[",
    "CaGMG[ RGQJNLMOMQNRQR[ RRQUNWMZM\\N]Q][", "I\\MMM[ RMQPNRMUMWNXQX[",
    "I\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM", "H[LMLb RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    "I\\XMXb RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", "KXOMO[ ROSPPRNTMWM",
    "J[XPWNTMQMNNMPNRPSUTWUXWXXWZT[Q[NZMX", "MYRFRWSZU[W[ ROMVM", "I\\MMMWNZP[S[UZXW RXMX[",
    "JZLMR[ RXMR[", "G]JMN[ RRMN[ RRMV[ RZMV[", "J[MMX[ RXMM[", "JZLMR[ RXMR[P_NaLbKb",
    "J[XMM[ RMMXM RM[X[",
    "KYTBRCQDPFPHQJRKSMSOQQ RRCQEQGRISJTLTNSPORSTTVTXSZR[Q]Q_Ra RQSSUSWRYQZP\\P^Q`RaTb",
    "NVRBRb",
    "KYPBRCSDTFTHSJRKQMQOSQ RRCSESGRIQJPLPNQPURQTPVPXQZR[S]S_Ra RSSQUQWRYSZT\\T^S`RaPb",
    "F^IUISJPLONOPPTSVTXTZS[Q RISJQLPNPPQTTVUXUZT[Q[O",
  ],
  /* Past ASCII, by character. */
  more: {
    '\u00B5': "H]OMIb RNQMVMYO[Q[SZUXWT RYMWTVXVZW[Y[[Y\\W",          // µ, greeks.jhf 638
    '\u03A9': "H\\K[O[LTKPKLLINGQFSFVGXIYLYPXTU[Y[",                   // Ω, greeks.jhf 550
    '\u00B0': "KYQFOGNINKOMQNSNUMVKVIUGSFQF",                          // °, greeks.jhf 718
    /* Drawn here. ± is + raised and shortened over a bar on the baseline, with the gap
       between them as wide as the gap in =, so the two do not run together. × is +
       turned 45 degrees, its arms 8.5 units to +'s 9. Ø is O, unchanged, with one
       stroke through it from below the baseline to above the cap. */
    '\u00B1': "E_RGRU RIN[N RI[[[",                                    // ±
    '\u00D7': "G]LLXX RXLLX",                                          // ×
    '\u00D8': "G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RI][D",    // Ø
  },
};

if (typeof module !== 'undefined') module.exports = HERSHEY_SIMPLEX;
