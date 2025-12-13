import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MAPBOX_TOKEN, DEFAULT_CENTER, ZOOM_LEVEL, FEATURED_CAFES, MAP_STYLE } from './constants';
import { getWalkingRoute, getDetourRoute, getDistance, fetchPointElevation } from './services/mapboxService';
import { curateDestinations } from './services/geminiService';
import { Coordinates, EnrichedDestination } from './types';
import Sidebar from './components/Sidebar';
import { Locate, MapPin, Menu, Save, List } from 'lucide-react';
import { getOpenStatus } from './utils/openingHours';

const App: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const markersRef = useRef<any[]>([]); 
  const routeLayerRef = useRef<any>(null); 
  const userMarkerRef = useRef<any>(null);
  const scenicMarkerRef = useRef<any>(null);
  
  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const [userElevation, setUserElevation] = useState<number | undefined>(undefined);
  const [gpsLocation, setGpsLocation] = useState<Coordinates | null>(null); // Track actual GPS separately
  const [destinations, setDestinations] = useState<EnrichedDestination[]>([]);
  const [selectedDestination, setSelectedDestination] = useState<EnrichedDestination | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [hasInitialLoaded, setHasInitialLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  
  // Refs to track state inside effects without triggering re-renders or loops
  const selectedDestRef = useRef<EnrichedDestination | null>(null);
  const lastCalcLocation = useRef<Coordinates | null>(null);
  const destinationsRef = useRef<EnrichedDestination[]>([]);

  // Sync refs
  useEffect(() => { selectedDestRef.current = selectedDestination; }, [selectedDestination]);
  useEffect(() => { destinationsRef.current = destinations; }, [destinations]);

  // Debug / Calibration Mode
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [debugLog, setDebugLog] = useState<string>('');

  // Swipe Up State for Mobile Button
  const [btnTouchStart, setBtnTouchStart] = useState<number | null>(null);

  // Mobile Detection and Initial State
  useEffect(() => {
    const checkMobile = () => {
      if (typeof window !== 'undefined') {
        setIsMobile(window.innerWidth < 768);
      }
    };
    checkMobile();
    
    // On mobile, start with sidebar closed so user sees map
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false);
    }

    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // AUTO-REFETCH REAL ROUTE IF SELECTED ITEM BECOMES AN ESTIMATE
  useEffect(() => {
    if (selectedDestination && selectedDestination.route?.isEstimate && userLocation && !isLoading) {
       console.log("Upgrading selected destination from estimate to real route...");
       getWalkingRoute(
           userLocation, 
           selectedDestination.coordinates, 
           false, 
           false, 
           selectedDestination.preferredWaypoints,
           userElevation,
           selectedDestination.elevation
        ).then(route => {
          if (route) {
             const updated = { ...selectedDestination, route };
             // Update main state
             setSelectedDestination(updated);
             // Also update it in the list so it doesn't revert
             setDestinations(prev => prev.map(d => d.id === updated.id ? updated : d));
             plotRouteOnMap(route);
          }
       }).catch(e => console.warn("Failed to auto-upgrade route:", e));
    }
  }, [selectedDestination, userLocation, isLoading, userElevation]);

  const updateUserMarker = useCallback((lat: number, lng: number) => {
     if (!map.current) return;
     
     // Strict check to prevent Leaflet crashing with Invalid LatLng
     if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(lat) || Number.isNaN(lng)) {
        console.warn("Attempted to update user marker with invalid coordinates:", { lat, lng });
        return;
     }
     
     if (userMarkerRef.current) {
        userMarkerRef.current.setLatLng([lat, lng]);
     } else {
        const userIcon = window.L.divIcon({
          className: 'custom-div-icon',
          html: `<div class="w-6 h-6 bg-teal-500 rounded-full border-4 border-white shadow-xl pulse-animation cursor-grab active:cursor-grabbing"></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        const marker = window.L.marker([lat, lng], { 
            icon: userIcon,
            draggable: true,
            zIndexOffset: 1000 // Ensure user marker is always on top
        }).addTo(map.current);
        
        marker.on('dragend', (event: any) => {
            const pos = event.target.getLatLng();
            if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
                setUserLocation({ lat: pos.lat, lng: pos.lng });
                // Note: We don't re-fetch elevation on drag to keep API usage low, 
                // but you could add it here if needed.
            }
        });

        // Add a simple tooltip for UX
        marker.bindTooltip("Drag to change start", { direction: 'top', offset: [0, -10] });

        userMarkerRef.current = marker;
     }
  }, []);

  // Initialize Map
  useEffect(() => {
    if (map.current) return;
    if (!mapContainer.current) return;

    if (!window.L) {
      setMapError("Leaflet library failed to load.");
      return;
    }

    try {
      const newMap = window.L.map(mapContainer.current, {
        zoomControl: false,
        attributionControl: false // Disable default attribution (which is bottom-right)
      }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], ZOOM_LEVEL);

      // Add attribution manually to bottom-left so it isn't covered by the sidebar
      window.L.control.attribution({
        position: 'bottomleft'
      }).addTo(newMap);

      // Map Style
      window.L.tileLayer(
        `https://api.mapbox.com/styles/v1/${MAP_STYLE}/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}&tileSize=512&zoomOffset=-1`, 
        {
          maxZoom: 19,
          tileSize: 512,
          zoomOffset: -1,
          attribution: '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> <strong><a href="https://www.mapbox.com/map-feedback/" target="_blank">Improve this map</a></strong>'
        }
      ).addTo(newMap);

      window.L.control.zoom({ position: 'topleft' }).addTo(newMap);

      // Add click listener for manual location setting
      newMap.on('click', (e: any) => {
         const { lat, lng } = e.latlng;
         if (Number.isFinite(lat) && Number.isFinite(lng)) {
             setUserLocation({ lat, lng });
             updateUserMarker(lat, lng);
             // Fetch elevation for new start point
             fetchPointElevation({ lat, lng }).then(ele => {
                 if (ele !== null) setUserElevation(ele);
             });
         }
      });

      map.current = newMap;

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            const { longitude, latitude } = position.coords;
            
            // Strict check for valid numbers
            if (
              typeof longitude !== 'number' || 
              typeof latitude !== 'number' || 
              !Number.isFinite(longitude) || 
              !Number.isFinite(latitude)
            ) {
              console.warn("Invalid geolocation coordinates received");
              return;
            }

            const coords = { lng: longitude, lat: latitude };
            setUserLocation(coords);
            setGpsLocation(coords); // Store actual GPS
            updateUserMarker(latitude, longitude);
            
            // 1. Fetch Elevation for User (ONCE)
            fetchPointElevation(coords).then(ele => {
                if (ele !== null) setUserElevation(ele);
            });
            
            if (map.current && !selectedDestination) {
                map.current.flyTo([latitude, longitude], 13, { animate: true, duration: 1.5 });
            }
          },
          (err) => console.error("Geolocation error:", err),
          { enableHighAccuracy: true }
        );
      }
    } catch (e) {
      console.error("Error initializing map:", e);
      setMapError("Error initializing map.");
    }

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Effect to re-plot markers when debug mode toggles
  useEffect(() => {
    if (destinations.length > 0) {
      plotMarkers(destinations);
    }
  }, [isDebugMode]);

  // Effect to handle selection-specific map visuals (Z-index, scenic markers)
  useEffect(() => {
    if (!map.current) return;

    // 1. Z-Index Management
    markersRef.current.forEach((marker: any) => {
        if (selectedDestination && marker.placeId === selectedDestination.id) {
            marker.setZIndexOffset(1000); // Bring to front
        } else {
            marker.setZIndexOffset(0);
        }
    });

    // 2. Scenic Marker Visualization
    if (scenicMarkerRef.current) {
        scenicMarkerRef.current.remove();
        scenicMarkerRef.current = null;
    }

    if (selectedDestination?.route?.viaWaypoint) {
        const { lat, lng } = selectedDestination.route.viaWaypoint.coordinates;
        const name = selectedDestination.route.viaWaypoint.name;
        
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const treeIcon = window.L.divIcon({
              className: 'custom-div-icon',
              html: `<div class="flex flex-col items-center transform -translate-y-6">
                        <div class="w-8 h-8 bg-emerald-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v-9"/><path d="M7 19h10"/><path d="M7 10l5-8 5 8"/></svg>
                        </div>
                        <div class="mt-1 bg-white/90 px-2 py-0.5 rounded shadow text-[10px] font-bold text-emerald-800 whitespace-nowrap border border-emerald-100">
                            Via ${name}
                        </div>
                     </div>`,
              iconSize: [120, 60],
              iconAnchor: [60, 30] 
            });

            scenicMarkerRef.current = window.L.marker([lat, lng], { 
                icon: treeIcon, 
                interactive: false,
                zIndexOffset: 500
            }).addTo(map.current);
        }
    }

  }, [selectedDestination]);

  const handleMarkerDragEnd = (id: string, newLat: number, newLng: number) => {
    setDestinations(prev => {
      const updated = prev.map(d => 
        d.id === id ? { ...d, coordinates: { lat: newLat, lng: newLng } } : d
      );
      return updated;
    });
  };

  const plotMarkers = (places: EnrichedDestination[]) => {
    if (!map.current) return;

    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];
    
    const group = window.L.featureGroup();

    places.forEach((place) => {
      if (
        !place.coordinates || 
        typeof place.coordinates.lat !== 'number' || 
        typeof place.coordinates.lng !== 'number' || 
        !Number.isFinite(place.coordinates.lat) || 
        !Number.isFinite(place.coordinates.lng)
      ) {
        // Skip invalid coordinates
        return;
      }
      
      const openStatus = getOpenStatus(place.openingHours);
      const isClosed = openStatus && !openStatus.isOpen;
      const opacityClass = isClosed ? 'opacity-50 grayscale contrast-75' : '';

      const bunSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#78350F" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="${opacityClass}">
          <circle cx="12" cy="12" r="10" fill="#FDE68A" stroke="white" stroke-width="1" />
          <path d="M12 12 m1 0 a 1 1 0 0 0 -2 0 a 2 2 0 0 0 4 0 a 3 3 0 0 0 -6 0 a 4 4 0 0 0 8 0 a 5 5 0 0 0 -10 0 a 6 6 0 0 0 12 0" opacity="0.8" />
        </svg>`;
      
      const beerSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="${opacityClass}">
          <circle cx="12" cy="12" r="10" fill="#FFE4E6" stroke="white" stroke-width="2" />
          <path d="M16 9h1a2 2 0 0 1 0 4h-1" stroke="#881337" stroke-width="2" />
          <path d="M8 6h8v11a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3V6z" fill="#f43f5e" stroke="#881337" stroke-width="2" />
          <path d="M8 6c0-1.5 2-2 4-2s4 .5 4 2" fill="white" stroke="#881337" stroke-width="2" />
        </svg>`;

      const iconSvg = place.category === 'bar' ? beerSvg : bunSvg;

      const placeIcon = window.L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="transform ${isDebugMode ? 'animate-bounce' : 'hover:scale-110 active:scale-95'} transition-all cursor-pointer drop-shadow-xl" style="filter: drop-shadow(0 4px 6px rgba(0,0,0,0.2));">${iconSvg}</div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -20]
      });

      const marker = window.L.marker([place.coordinates.lat, place.coordinates.lng], { 
        icon: placeIcon,
        draggable: isDebugMode,
        opacity: isClosed ? 0.7 : 1 // Also set Leaflet opacity
      })
        .addTo(map.current)
        .bindTooltip(place.name + (isClosed ? " (Closed)" : ""), {
          direction: 'top',
          offset: [0, -20],
          opacity: 1,
          permanent: isDebugMode,
          className: 'font-serif font-bold text-stone-900 bg-white shadow-md rounded px-2 py-1 border-0'
        })
        .on('click', (e: any) => {
          e.originalEvent.stopPropagation();
          if (!isDebugMode) handleSelectDestination(place);
        })
        .on('dragend', (e: any) => {
          const pos = e.target.getLatLng();
          if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
              handleMarkerDragEnd(place.id, pos.lat, pos.lng);
          }
        });
      
      // Store ID for easy retrieval later
      (marker as any).placeId = place.id;
      
      markersRef.current.push(marker);
      group.addLayer(marker);
    });
  };

  const processDestinations = async (places: EnrichedDestination[], location: Coordinates) => {
    // Optimization: Don't fetch full routes for everyone. 
    // Just calculate straight line distance for sorting and initial display.
    // We only fetch the real route when user clicks "Go" or selects details.
    
    const placesWithEstimates = places.map((place) => {
      // Guard against invalid inputs
      if (!place.coordinates || !Number.isFinite(place.coordinates.lat) || !Number.isFinite(place.coordinates.lng)) {
            return place;
      }
      
      // Calculate Haversine (straight line) distance
      const dist = getDistance(location, place.coordinates);
      
      // Create a "Lite" route object so UI doesn't crash, but without geometry steps
      // Apply a factor (1.4) to estimate actual walking distance vs straight line
      const estimatedWalkingDist = dist * 1.35; 
      
      // Calculate Net Elevation (Math only, no API calls)
      let elevationGain = undefined;
      if (typeof place.elevation === 'number' && typeof userElevation === 'number') {
          elevationGain = place.elevation - userElevation;
      }

      return { 
          ...place, 
          route: {
              distance: estimatedWalkingDist,
              duration: estimatedWalkingDist / 1.4, // avg walking speed approx 1.4m/s
              geometry: { coordinates: [] }, // Empty geometry
              steps: [],
              isEstimate: true,
              elevationGain // This is "Net Elevation" now
          }
      };
    });

    // 2. Curate with Gemini
    return await curateDestinations(placesWithEstimates);
  };

  // Initial Load
  useEffect(() => {
    if (!hasInitialLoaded && map.current) {
      setDestinations(FEATURED_CAFES as EnrichedDestination[]);
      plotMarkers(FEATURED_CAFES as EnrichedDestination[]);
      
      if (markersRef.current.length > 0) {
        const group = window.L.featureGroup(markersRef.current);
        // Ensure bounds are valid before fitting
        const bounds = group.getBounds();
        if (bounds.isValid()) {
            map.current.fitBounds(bounds, { padding: [50, 50] });
        }
      }

      setHasInitialLoaded(true);
    }
  }, [hasInitialLoaded]);

  // Update routes when user location becomes available OR CHANGES (e.g. drag)
  useEffect(() => {
    const updateRoutesForInitial = async () => {
      // If userLocation changes, ensure marker is at correct spot
      if (userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
         updateUserMarker(userLocation.lat, userLocation.lng);
      }
      
      // Check if location actually changed to prevent loops
      const isLocationChanged = 
          !lastCalcLocation.current || 
          (userLocation && (
              Math.abs(userLocation.lat - lastCalcLocation.current.lat) > 0.00001 || 
              Math.abs(userLocation.lng - lastCalcLocation.current.lng) > 0.00001
          ));

      // We re-run processing if userElevation changes so the Net Elevation numbers appear
      const isElevationChanged = userElevation !== undefined;

      if (userLocation && destinations.length > 0 && !isLoading && (isLocationChanged || isElevationChanged)) {
        setIsLoading(true);
        lastCalcLocation.current = userLocation;

        try {
          const curated = await processDestinations(destinationsRef.current.length > 0 ? destinationsRef.current : destinations, userLocation);
          curated.sort((a, b) => (a.route?.distance || Infinity) - (b.route?.distance || Infinity));
          setDestinations(curated);
          plotMarkers(curated);
          
          // Clear routes on map since they are now invalid/estimates
          if (routeLayerRef.current && map.current) {
              map.current.removeLayer(routeLayerRef.current);
              routeLayerRef.current = null;
          }
          if (scenicMarkerRef.current) {
              scenicMarkerRef.current.remove();
              scenicMarkerRef.current = null;
          }

          // If a destination is currently open, we should probably update its distance estimates 
          // but NOT fetch the real route automatically unless they interact again
          if (selectedDestRef.current) {
              const updatedSelected = curated.find(d => d.id === selectedDestRef.current?.id);
              if (updatedSelected) {
                  setSelectedDestination(updatedSelected);
              }
          }
        } catch (e) {
          console.error(e);
        } finally {
          setIsLoading(false);
        }
      }
    };
    updateRoutesForInitial();
  }, [userLocation, userElevation]); // Re-run if location/elevation changes

  const handleSelectDestination = useCallback(async (destination: EnrichedDestination) => {
    // 1. Set selection immediately
    setSelectedDestination(destination);
    if (!isMobile) setSidebarOpen(true);
    
    if (!map.current) return;

    // 2. Fetch REAL route if missing or if it's just an estimate
    let routeToUse = destination.route;
    const isEstimate = routeToUse?.isEstimate;

    // We fetch if:
    // a) No route exists
    // b) It is an estimate
    // c) User moved and the route is stale
    
    if (userLocation && (!routeToUse || isEstimate)) {
        setIsLoading(true);
        try {
            const fetchedRoute = await getWalkingRoute(
                userLocation, 
                destination.coordinates, 
                false, 
                false, 
                destination.preferredWaypoints,
                userElevation,
                destination.elevation
            );
            if (fetchedRoute) {
                routeToUse = fetchedRoute;
                const updatedDest = { ...destination, route: fetchedRoute };
                
                // Update state with real route
                setSelectedDestination(updatedDest);
                setDestinations(prev => prev.map(d => d.id === destination.id ? updatedDest : d));
                
                // Now plot the REAL route
                plotRouteOnMap(fetchedRoute);
            }
        } catch (e) {
            console.error("Failed to fetch route on click", e);
        } finally {
            setIsLoading(false);
        }
    } else if (routeToUse) {
        // Just plot existing real route
        plotRouteOnMap(routeToUse);
    }

  }, [userLocation, isMobile, userElevation]);

  const handleUpdateRoute = useCallback(async (destinationId: string, targetDistanceKm: number, isRoundTrip: boolean, isScenic: boolean) => {
    if (!userLocation) return;
    const dest = destinations.find(d => d.id === destinationId);
    if (!dest) return;
    
    // Guard dest coords
    if (!dest.coordinates || !Number.isFinite(dest.coordinates.lat) || !Number.isFinite(dest.coordinates.lng)) return;

    try {
      // Pass dest.preferredWaypoints and linkedScenicRouteId to getDetourRoute
      const newRoute = await getDetourRoute(
          userLocation, 
          dest.coordinates, 
          targetDistanceKm, 
          isRoundTrip, 
          isScenic,
          dest.preferredWaypoints,
          dest.linkedScenicRouteId,
          userElevation,
          dest.elevation
      );
      
      if (newRoute) {
        const updatedDest = { ...dest, route: newRoute };
        setSelectedDestination(updatedDest);
        setDestinations(prev => prev.map(d => d.id === destinationId ? updatedDest : d));
        
        plotRouteOnMap(newRoute);
      }
    } catch (e) {
      console.error("Failed to update route", e);
    }
  }, [userLocation, destinations, userElevation]);

  const plotRouteOnMap = (route: any) => {
    if (!map.current || !route) return;
    
    // Don't plot empty geometries from estimates
    if (!route.geometry || !route.geometry.coordinates || route.geometry.coordinates.length === 0) return;

    if (routeLayerRef.current) {
      map.current.removeLayer(routeLayerRef.current);
      routeLayerRef.current = null;
    }

    try {
        // Deep validation of geometry coordinates to prevent NaN
        const isValid = route.geometry.coordinates.every((coord: any) => 
            Array.isArray(coord) && 
            coord.length >= 2 && 
            typeof coord[0] === 'number' && Number.isFinite(coord[0]) &&
            typeof coord[1] === 'number' && Number.isFinite(coord[1])
        );

        if (!isValid) {
            console.warn("Skipping plot: Invalid coordinates in route geometry");
            return;
        }

        const routeLayer = window.L.geoJSON(route.geometry, {
        style: {
            color: '#f59e0b',
            weight: 6,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round'
        }
        }).addTo(map.current);

        const shadowLayer = window.L.geoJSON(route.geometry, {
        style: {
            color: 'white',
            weight: 10,
            opacity: 0.8,
            lineCap: 'round',
            lineJoin: 'round'
        }
        }).addTo(map.current);
        
        const routeGroup = window.L.layerGroup([shadowLayer, routeLayer]).addTo(map.current);
        routeLayerRef.current = routeGroup;

        if (routeLayer.getBounds().isValid()) {
            // Adjust padding for mobile so the route is not hidden behind the bottom sheet
            // Sheet is approx 55-65vh. So we need large bottom padding.
            const paddingConfig = isMobile 
                ? { paddingTopLeft: [20, 20], paddingBottomRight: [20, window.innerHeight * 0.60] } 
                : { paddingTopLeft: [50, 50], paddingBottomRight: [400, 50] };

            map.current.fitBounds(routeLayer.getBounds(), paddingConfig);
        }
    } catch (e) {
        console.error("Error plotting route:", e);
    }
  };

  const handleCategoryFilter = async (type: 'cafe' | 'bar') => {
    setIsLoading(true);
    setSidebarOpen(true);
    setSelectedDestination(null);
    if (routeLayerRef.current && map.current) {
        map.current.removeLayer(routeLayerRef.current);
        routeLayerRef.current = null;
    }

    try {
      const filtered = FEATURED_CAFES.filter(p => p.category === type);
      
      let finalPlaces = filtered as EnrichedDestination[];

      if (userLocation) {
        finalPlaces = await processDestinations(filtered as EnrichedDestination[], userLocation);
        finalPlaces.sort((a, b) => (a.route?.distance || Infinity) - (b.route?.distance || Infinity));
      }
      
      setDestinations(finalPlaces);
      plotMarkers(finalPlaces);

      if (map.current && userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
         if (markersRef.current.length > 0) {
            const group = window.L.featureGroup(markersRef.current);
            // Include user location in bounds
            const bounds = group.getBounds();
            if (bounds.isValid()) {
                // Double check to ensure we don't pass NaNs to extend
                if (Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
                    bounds.extend([userLocation.lat, userLocation.lng]);
                    // Add bottom padding for mobile sheet
                    const paddingConfig = isMobile 
                        ? { paddingTopLeft: [20, 20], paddingBottomRight: [20, window.innerHeight * 0.55] }
                        : { padding: [50, 50] };
                    
                    map.current.fitBounds(bounds, paddingConfig);
                }
            }
         }
      }
    } catch (error) {
      console.error("Workflow failed:", error);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleBackToList = useCallback(() => {
    setSelectedDestination(null);
    if (routeLayerRef.current && map.current) {
        map.current.removeLayer(routeLayerRef.current);
        routeLayerRef.current = null;
    }
    // Remove scenic marker on back
    if (scenicMarkerRef.current) {
        scenicMarkerRef.current.remove();
        scenicMarkerRef.current = null;
    }
    if (isMobile) setSidebarOpen(true);
  }, [isMobile]);

  const handleCloseSidebar = useCallback(() => {
      setSidebarOpen(false);
      setSelectedDestination(null);
      if (routeLayerRef.current && map.current) {
        map.current.removeLayer(routeLayerRef.current);
        routeLayerRef.current = null;
    }
    if (scenicMarkerRef.current) {
        scenicMarkerRef.current.remove();
        scenicMarkerRef.current = null;
    }
  }, []);

  const recenter = () => {
    const centerMap = (lat: number, lng: number) => {
        if (!map.current) return;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return; // Guard
        
        // On mobile, if sheet is open, the visual center is higher up.
        // Simple flyTo handles geometric center. 
        // We could implement offset logic but flyTo is standard.
        map.current.flyTo([lat, lng], 14, { animate: true });
    };

    // If we have GPS capabilities, try to get fresh location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { longitude, latitude } = position.coords;
                if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

                const coords = { lng: longitude, lat: latitude };
                setGpsLocation(coords);
                setUserLocation(coords); // Reset start pin to actual location
                updateUserMarker(latitude, longitude);
                // Also fetch elevation for new GPS point
                fetchPointElevation(coords).then(ele => {
                    if (ele !== null) setUserElevation(ele);
                });
                centerMap(latitude, longitude);
            },
            () => {
               // Error or timeout? Fallback to stored gpsLocation if available
               if (gpsLocation && Number.isFinite(gpsLocation.lat) && Number.isFinite(gpsLocation.lng)) {
                   setUserLocation(gpsLocation);
                   updateUserMarker(gpsLocation.lat, gpsLocation.lng);
                   centerMap(gpsLocation.lat, gpsLocation.lng);
               } else if (userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
                   centerMap(userLocation.lat, userLocation.lng);
               }
            },
            { enableHighAccuracy: true }
        );
    } else if (userLocation && map.current && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
        centerMap(userLocation.lat, userLocation.lng);
    }
  };

  const toggleDebug = () => setIsDebugMode(!isDebugMode);

  const getSidebarClasses = () => {
    if (!isMobile) {
        return `absolute inset-y-0 right-0 w-96 z-[2000] shadow-2xl transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : 'translate-x-full'}`;
    }
    
    // Mobile Bottom Sheet Logic
    // Using flex-col to ensure internal scrolling works within the fixed height
    const baseClasses = "fixed left-0 right-0 z-[2000] transition-transform duration-300 bg-white shadow-[0_-4px_20px_rgba(0,0,0,0.15)] rounded-t-3xl flex flex-col";

    if (selectedDestination) {
        // Detail View: Occupy 65% of screen
        return `${baseClasses} bottom-0 h-[65vh] translate-y-0`;
    }
    if (sidebarOpen) {
        // List View: Occupy 55% of screen (allows map visibility)
        return `${baseClasses} bottom-0 h-[55vh] translate-y-0`;
    }
    
    // Closed: Hidden below screen
    return `${baseClasses} bottom-0 h-[55vh] translate-y-full`;
  };

  // Mobile Button Gesture Handlers
  const handleBtnTouchStart = (e: React.TouchEvent) => setBtnTouchStart(e.targetTouches[0].clientY);
  const handleBtnTouchEnd = (e: React.TouchEvent) => {
    if (btnTouchStart === null) return;
    const touchEnd = e.changedTouches[0].clientY;
    if (btnTouchStart - touchEnd > 50) { // Swipe Up
        setSidebarOpen(true);
    }
    setBtnTouchStart(null);
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-stone-100">
      {isMobile && !sidebarOpen && !selectedDestination && (
         <button 
           onClick={() => setSidebarOpen(true)} 
           onTouchStart={handleBtnTouchStart}
           onTouchEnd={handleBtnTouchEnd}
           className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[1500] bg-stone-900 text-white px-6 py-3 rounded-full font-bold shadow-lg flex items-center gap-2 active:scale-95 transition-transform touch-none"
         >
             <List size={20} /> Explore Spots
         </button>
      )}

      {/* Hide Desktop Menu Button on Mobile since we use Bottom Sheet interactions */}
      <button 
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="hidden md:block absolute top-4 right-4 z-[2010] bg-white text-stone-800 p-2 rounded-lg shadow-lg border border-stone-200"
      >
        <Menu size={20} />
      </button>

      <div className={getSidebarClasses()}>
        <Sidebar 
          destinations={destinations}
          selectedDestination={selectedDestination}
          onSelect={handleSelectDestination}
          onBack={handleBackToList}
          onCloseSidebar={handleCloseSidebar}
          onSearch={handleCategoryFilter}
          onUpdateRoute={handleUpdateRoute}
          isLoading={isLoading}
          userLocation={userLocation}
          isDebugMode={isDebugMode}
          onToggleDebug={toggleDebug}
          isMobile={isMobile}
        />
      </div>

      <div ref={mapContainer} className={`w-full h-full z-0 ${isDebugMode ? 'cursor-crosshair' : ''}`} />
      
      {isDebugMode && (
        <div className="absolute top-0 left-0 bottom-0 w-96 bg-black/90 text-green-400 p-6 z-[2500] font-mono text-xs overflow-auto shadow-xl border-r border-green-900">
          <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-2">
            <Save size={18} /> Calibration Mode
          </h3>
          <p className="text-stone-400 mb-4">
            Drag markers on the map to correct their locations.
          </p>
          <div className="bg-black border border-green-800 p-2 rounded mb-4">
             {debugLog || "Drag a marker to generate code..."}
          </div>
        </div>
      )}
      
      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-stone-100 z-[3000] text-stone-800 p-4 text-center">
          <div>
             <MapPin className="mx-auto mb-4 text-rose-500" size={48} />
             <h2 className="text-xl font-bold mb-2">Map Error</h2>
             <p className="text-stone-500">{mapError}</p>
          </div>
        </div>
      )}

      {/* Locate Button - Repositioned for Mobile to be Top-Right */}
      <button 
        onClick={recenter}
        className={`absolute z-[1001] bg-white hover:bg-stone-50 text-teal-600 p-3 rounded-full shadow-xl border border-stone-200 transition-all active:scale-95
            md:bottom-8 md:left-8 md:right-auto md:top-auto
            top-20 right-4 
            ${isMobile && selectedDestination ? 'top-4 right-4' : ''} 
        `}
      >
        <Locate size={24} />
      </button>
    </div>
  );
};

export default App;