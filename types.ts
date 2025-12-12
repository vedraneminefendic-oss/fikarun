export interface Coordinates { lng: number; lat: number; }
export interface Place { id: string; name: string; address: string; coordinates: Coordinates; category: 'cafe' | 'bar'; elevation?: number; }
export interface RouteStep { instruction: string; distance: number; location?: Coordinates; }
export interface RouteData { distance: number; duration: number; geometry: any; steps: RouteStep[]; elevationGain?: number; viaWaypoint?: { name: string; coordinates: Coordinates; }; isEstimate?: boolean; }
export interface EnrichedDestination extends Place { route?: RouteData; geminiTitle?: string; geminiDescription?: string; geminiTip?: string; openingHours?: string; playlistVibe?: string; preferredWaypoints?: Coordinates[]; linkedScenicRouteId?: string; }
export interface ScenicRoute { id: string; name: string; description: string; pointA: Coordinates; pointB: Coordinates; waypoints: Coordinates[]; }
export interface Product { id: string; name: string; brand: string; price: string; image: string; description: string; tags: ('rain' | 'sun' | 'cold' | 'night' | 'general')[]; affiliateLink: string; }
// Removed Window.L declaration