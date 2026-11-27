/** How many alerts fire right now, kept in memory so every page header can show it without a query. */
let firing = 0;

export function setFiring(count: number): void {
	firing = Math.max(0, count);
}

export function firingCount(): number {
	return firing;
}
